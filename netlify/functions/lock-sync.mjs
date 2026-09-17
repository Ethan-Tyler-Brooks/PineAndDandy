// Daily smart-lock battery sync from Hospitable → cabin-ops blobs. 11:00 UTC = 6am CDT / 5am CST.
import { syncLocks } from "../lib/ops.mjs";

export default async () => {
  const result = await syncLocks();
  console.log("lock-sync", JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 11 * * *" };
