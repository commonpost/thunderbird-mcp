// Test bench profile (scripts/tb-bench.sh). Synthetic accounts only.
// Extension loading (same as tb-compat-test.yml)
user_pref("extensions.experiments.enabled", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.update.enabled", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);

// No first-run UI, no network
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("mail.shell.checkDefaultClient", false);
user_pref("mail.spotlight.firstRunDone", true);
user_pref("mail.winsearch.firstRunDone", true);
user_pref("mailnews.start_page.enabled", false);
user_pref("mail.startup.enabledMailCheckOnce", true);
user_pref("mail.biff.show_alert", false);
user_pref("mail.biff.play_sound", false);
user_pref("calendar.timezone.useSystemTimezone", true);
user_pref("browser.dom.window.dump.enabled", true);

// Gloda on (as a real profile), short initial wait handled by the bench
user_pref("mailnews.database.global.indexer.enabled", true);

// Accounts: POP3 account (default, holds the identity) + Local Folders.
// Local Folders alone cannot be the default account (server type "none").
user_pref("mail.accountmanager.accounts", "account1,account2");
user_pref("mail.accountmanager.defaultaccount", "account1");
user_pref("mail.accountmanager.localfoldersserver", "server2");
user_pref("mail.account.account1.identities", "id1");
user_pref("mail.account.account1.server", "server1");
user_pref("mail.account.account2.server", "server2");

user_pref("mail.identity.id1.fullName", "Bench User");
user_pref("mail.identity.id1.useremail", "me@bench.test");
user_pref("mail.identity.id1.valid", true);
user_pref("mail.identity.id1.compose_html", true);
user_pref("mail.identity.id1.draft_folder", "mailbox://benchuser@127.0.0.1/Drafts");
user_pref("mail.identity.id1.drafts_folder_picker_mode", "0");
user_pref("mail.identity.id1.fcc_folder", "mailbox://benchuser@127.0.0.1/Sent");
user_pref("mail.identity.id1.fcc_folder_picker_mode", "0");
user_pref("mail.identity.id1.stationery_folder", "mailbox://benchuser@127.0.0.1/Templates");
user_pref("mail.identity.id1.tmpl_folder_picker_mode", "0");
user_pref("mail.identity.id1.smtpServer", "");

user_pref("mail.server.server1.type", "pop3");
user_pref("mail.server.server1.hostname", "127.0.0.1");
user_pref("mail.server.server1.port", 1);
user_pref("mail.server.server1.userName", "benchuser");
user_pref("mail.server.server1.name", "Bench POP");
user_pref("mail.server.server1.directory-rel", "[ProfD]Mail/127.0.0.1");
user_pref("mail.server.server1.login_at_startup", false);
user_pref("mail.server.server1.check_new_mail", false);
user_pref("mail.server.server1.download_on_biff", false);
user_pref("mail.server.server1.deferred_to_account", "");

user_pref("mail.server.server2.type", "none");
user_pref("mail.server.server2.hostname", "Local Folders");
user_pref("mail.server.server2.userName", "nobody");
user_pref("mail.server.server2.name", "Local Folders");
user_pref("mail.server.server2.directory-rel", "[ProfD]Mail/Local Folders");
