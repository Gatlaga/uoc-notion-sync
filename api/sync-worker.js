import { supabaseAdmin } from '../lib/supabase.js';
import { buildNotionProperties, throttledNotionUpdate } from '../lib/notion.js';

// SAFETY-NET DRAIN, not the primary sync path. Primary sync is instant, via
// the Supabase Database Webhook -> /api/sync-row.js (see README). This runs
// once a day (Vercel Hobby plan only allows daily crons) to retry anything
// that stayed "pending" — e.g. the webhook fired while Vercel was
// redeploying, or a transient Notion API error.
export default async function handler(req, res) {
  // Vercel Cron automatically sends `Authorization: Bearer <CRON_SECRET>`
  // when you set a CRON_SECRET env var — see Vercel docs "Securing cron jobs".
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const BATCH_SIZE = 20; // stays well under Notion's rate limit given the throttle in lib/notion.js

  const { data: pending, error } = await supabaseAdmin
    .from('sync_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error('sync_queue fetch failed', error);
    return res.status(500).json({ error: error.message });
  }

  const results = { sent: 0, failed: 0 };

  for (const job of pending ?? []) {
    try {
      const properties = buildNotionProperties(job.payload);
      await throttledNotionUpdate(job.notion_page_id, properties);

      await supabaseAdmin
        .from('sync_queue')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', job.id);

      // Reflect the successful push on the source row too, so the UI can
      // show "synced to Notion at ..." if you want that.
      const table = job.entity_type === 'subtask' ? 'subtasks' : 'documents';
      await supabaseAdmin
        .from(table)
        .update({ notion_last_synced_at: new Date().toISOString() })
        .eq('id', job.entity_id);

      results.sent++;
    } catch (err) {
      console.error('Notion push failed for job', job.id, err);
      await supabaseAdmin
        .from('sync_queue')
        .update({
          status: job.attempts >= 4 ? 'failed' : 'pending', // simple retry-then-give-up
          attempts: job.attempts + 1,
          last_error: String(err?.message ?? err),
        })
        .eq('id', job.id);
      results.failed++;
    }
  }

  return res.status(200).json({ ok: true, ...results, processed: pending?.length ?? 0 });
}
