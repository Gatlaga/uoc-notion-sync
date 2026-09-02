import { Client } from '@notionhq/client';

export const notion = new Client({ auth: process.env.NOTION_TOKEN });

/**
 * Build a Notion property-update payload from our simple
 * { "Status": "Хийгдэж байгаа" } / { "Дууссан": true } style payload.
 * Extend this map as you add more syncable fields.
 */
export function buildNotionProperties(payload) {
  const properties = {};

  if ('Status' in payload) {
    properties['Status'] = { status: { name: payload['Status'] } };
  }
  if ('Дууссан' in payload) {
    properties['Дууссан'] = { checkbox: !!payload['Дууссан'] };
  }

  return properties;
}

/**
 * Simple leaky-bucket throttle: Notion's limit is ~3 requests/second
 * (average, bursts tolerated). We stay safely under that.
 */
let lastCallAt = 0;
const MIN_INTERVAL_MS = 350; // ~2.8 req/s

export async function throttledNotionUpdate(pageId, properties) {
  const now = Date.now();
  const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();

  return notion.pages.update({
    page_id: pageId,
    properties,
  });
}
