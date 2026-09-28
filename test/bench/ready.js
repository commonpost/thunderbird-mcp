// Marionette chrome script (body of an async function, `args` = { expected, timeoutMs }).
// Parses the local mbox folders, starts the Gloda sweep and waits until the fixtures are indexed.
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const { Gloda } = ChromeUtils.importESModule("resource:///modules/gloda/GlodaPublic.sys.mjs");
const { GlodaConstants } = ChromeUtils.importESModule("resource:///modules/gloda/GlodaConstants.sys.mjs");
const { GlodaIndexer } = ChromeUtils.importESModule("resource:///modules/gloda/GlodaIndexer.sys.mjs");
const { GlodaMsgIndexer } = ChromeUtils.importESModule("resource:///modules/gloda/IndexMsg.sys.mjs");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deadline = Date.now() + (args.timeoutMs || 90000);

function parseFolder(folder) {
  return new Promise(resolve => {
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
      OnStartRunningUrl() {},
      OnStopRunningUrl() { resolve(); },
    };
    try {
      folder.QueryInterface(Ci.nsIMsgLocalMailFolder).getDatabaseWithReparse(listener, null);
      resolve();
    } catch (e) {
      if (e.result !== Cr.NS_ERROR_NOT_INITIALIZED) resolve();
    }
  });
}

const folders = {};
for (const server of MailServices.accounts.allServers) {
  for (const folder of server.rootFolder.descendants) {
    await parseFolder(folder);
    folders[folder.URI] = folder.msgDatabase ? [...folder.msgDatabase.enumerateMessages()].length : null;
  }
}

function glodaCount() {
  return new Promise(resolve => {
    const query = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE);
    query.getCollection({
      onItemsAdded() {},
      onItemsModified() {},
      onItemsRemoved() {},
      onQueryCompleted(collection) { resolve(collection.items.length); },
    });
  });
}

let indexed = 0;
if (args.expected) {
  GlodaMsgIndexer.indexingSweepNeeded = true;
  while (Date.now() < deadline) {
    indexed = await glodaCount();
    if (indexed >= args.expected && !GlodaIndexer.indexing) break;
    await sleep(500);
  }
}

const account = MailServices.accounts.defaultAccount;
return {
  folders,
  indexed,
  glodaEnabled: GlodaIndexer.enabled,
  defaultAccount: account ? { key: account.key, type: account.incomingServer.type } : null,
  appVersion: Services.appinfo.version,
};
