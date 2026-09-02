import { createClient } from '@supabase/supabase-js';

// Service-role client — used ONLY server-side (Vercel API routes), never
// exposed to the browser. This bypasses RLS so the worker can read/update
// the sync_queue table freely.
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
