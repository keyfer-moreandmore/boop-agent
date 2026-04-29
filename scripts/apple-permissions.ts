import "dotenv/config";
import { warmupAllPermissions } from "../server/integrations/apple-permissions.js";

console.log("Triggering Apple Automation prompts (Reminders, Notes)...");
console.log("Click 'OK' on each macOS prompt that appears.\n");

const results = await warmupAllPermissions();

for (const [slug, r] of Object.entries(results)) {
  const icon = r.status === "granted" ? "✓" : r.status === "denied" ? "✗" : "?";
  const detail =
    r.status === "granted"
      ? `(${r.durationMs}ms)`
      : r.errorMessage
        ? `— ${r.errorMessage}`
        : "";
  console.log(`${icon} ${slug}: ${r.status} ${detail}`);
}

const denied = Object.values(results).filter((r) => r.status === "denied");
if (denied.length) {
  console.log(
    "\nFix denied permissions in System Settings → Privacy & Security → Automation → Node",
  );
  process.exit(1);
}
