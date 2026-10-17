import { SupabaseStore } from "../server/supabase-store.mjs";

let store;
try {
  store = await SupabaseStore.open();
  console.log(
    JSON.stringify({
      storage: store.kind,
      accounts: store.all().length,
      workerLease: "acquired",
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await store?.close();
}
