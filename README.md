# rrmohite-updates

Official notifications, circulars and announcements from the Income Tax Department, CBIC (GST and Customs), RBI, SEBI, ICAI, NFRA, IRDAI, IBBI, IFSCA and NABARD, collected every three hours by `fetch.mjs` on GitHub Actions (NABARD from the firm's PC). Only official websites that allow automated reading are used.

`updates.json` is read by https://rrmohite.in/regulatory-updates. Each entry keeps the regulator's own wording and a link to the official document. Nothing here is reviewed or interpreted.

If a source keeps failing for about 12 hours, the scheduled run fails and GitHub emails the account owner.

NABARD does not answer GitHub's servers outside India, so GitHub skips it. A scheduled job on the firm's PC in Pune (`local/nabard-from-india.cmd`, set up once with `local/install-nabard-task.cmd`) collects NABARD circulars every 6 hours while the PC is on and pushes them here. Its failures never send alerts; the last collected circulars stay listed.
