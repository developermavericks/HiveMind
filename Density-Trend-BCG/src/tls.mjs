// Certificate checking must stay on: it is what protects the API keys this program sends over HTTPS. A machine that sets
// NODE_TLS_REJECT_UNAUTHORIZED=0 (often left over from debugging a proxy) silently turns it off for EVERY connection, so the program turns it back on.
// HIVEMIND_ALLOW_INSECURE_TLS=1 keeps the machine's setting, for the rare network that really needs it.
// Returns true when it had to switch checking back on.
export function enforceTls(env = process.env, warn = console.warn) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" || env.HIVEMIND_ALLOW_INSECURE_TLS === "1") return false;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  warn("Certificate checking was switched off by the environment (NODE_TLS_REJECT_UNAUTHORIZED=0). It is switched back on for this program; set HIVEMIND_ALLOW_INSECURE_TLS=1 to keep it off.");
  return true;
}
