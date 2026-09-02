import { supabaseAdmin } from '../lib/supabase.js';
import { buildNotionProperties, throttledNotionUpdate } from '../lib/notion.js';

/**
 * Called by a Supabase Database Webhook the instant a new row is inserted
 * into `sync_queue`. This replaces the old "poll every minute" cron —
 * Vercel's free (Hobby) plan only allows daily crons, so instead of paying
 * for Pro just to get a 1-minute cron, we let Postgres push to us directly
 * and get near-instant sync (typically under 2 seconds) for free.
 *
 * Supabase Database Webhook payload shape (Insert event):
 * { "type": "INSERT", "table": "sync_queue", "record": {...}, "schema": "public" }
 */
export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const job = req.body?.record;
  if (!job) {
    return res.status(400).json({ error: 'no record in payload' });
  }

  try {
    const properties = buildNotionProperties(job.payload);
    await throttledNotionUpdate(job.notion_page_id, properties);

    await supabaseAdmin
      .from('sync_queue')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', job.id);

    const table = job.entity_type === 'subtask' ? 'subtasks' : 'documents';
    await supabaseAdmin
      .from(table)
      .update({ notion_last_synced_at: new Date().toISOString() })
      .eq('id', job.entity_id);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Notion push failed for job', job.id, err);
    await supabaseAdmin
      .from('sync_queue')
      .update({
        status: (job.attempts ?? 0) >= 4 ? 'failed' : 'pending', // sync-worker.js drains this on its daily backup pass
        attempts: (job.attempts ?? 0) + 1,
        last_error: String(err?.message ?? err),
      })
      .eq('id', job.id);
    // Return 200 so Supabase doesn't endlessly retry the webhook itself —
    // the retry logic lives in our own sync_queue/attempts, not in Supabase's webhook retries.
    return res.status(200).json({ ok: false, error: String(err?.message ?? err) });
  }
}
