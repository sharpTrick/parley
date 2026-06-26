-- Maintainer dev/test Prosody config for the Parley XMPP backend (DESIGN §15).
-- NOT a production config. The one load-bearing requirement: MAM (mod_mam) MUST be enabled, or
-- catch-up (fetchRecent) has no archive to read.

admins = { }

modules_enabled = {
  "roster"; "saslauth"; "tls"; "dialback"; "disco";
  "carbons"; "pep"; "private"; "blocklist"; "vcard4"; "vcard_legacy";
  "mam";          -- REQUIRED: message archive management (fetchRecent/cursor)
  "smacks";
  "register";     -- dev only: allow in-band registration of test accounts
}

-- Dev only: no encryption requirement so test clients connect easily on localhost.
c2s_require_encryption = false
s2s_require_encryption = false
allow_registration = true

-- Archive everything, keep it (dev): MAM is the backend's history source.
archive_expires_after = "never"
default_archive_policy = true
max_archive_query_results = 250

VirtualHost "parley.local"

-- A MUC component: each room maps to a Parley topic. MAM on the MUC archives room history.
Component "muc.parley.local" "muc"
  modules_enabled = { "muc_mam" }
  muc_log_by_default = true
  muc_log_expires_after = "never"

log = { info = "*console"; }
