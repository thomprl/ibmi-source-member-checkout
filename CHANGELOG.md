# Change Log

# 1.0.4
- Files created in the checkout folder outside the extension (for example by an AI assistant) can now be added to your checkouts and created on the IBM i.
  - **Scan for New Local Files...** (Command Palette, or the **...** menu on the Checked Out Members panel) lists files that aren't checked out yet; the library, source file, member and type come from the folder and file names.
  - Turn on the new `ibmi-checkout.watchForNewFiles` setting (off by default) to have new files noticed as they appear, with an offer to add them.
  - Added files show with a blue **+** icon as **new — not on the IBM i yet**. **Create on IBM i** creates the member (`ADDPFM`, source type from the file extension) and uploads it. Works on a multi-selection.
  - Nothing is created if the source file doesn't exist, and a member that appeared on the IBM i in the meantime is never overwritten; it shows as a conflict for Merge Back instead.
- **Create on IBM i** is also available for members flagged as no longer existing on the IBM i, to put them back.
- Uploads now warn when lines are longer than the source file's record length allows, since those lines would be cut off.
- Refreshing a source file, library, selection or all checkouts now goes through members in the order the panel shows them, and the progress notification shows the member currently being checked (e.g. `Refreshing: PAYROLL (3/40)`).
- Checkouts whose local file was renamed, moved or deleted outside the extension are now flagged **local file missing** on refresh, with a red icon, instead of failing with an error. Nothing is removed automatically, and the status clears on the next refresh if the file comes back.
  - Opening one offers **Restore from Open Editor** (when its contents are still open in a tab), **Re-checkout from IBM i**, or **Remove from Checkouts**, instead of showing a stale editor tab.
  - **Scan for New Local Files** re-links a missing checkout to a file for the same member (for example after an extension change), keeping its checkout history.
  - Checking out the member again from the Object Browser downloads it without asking about the existing checkout.
  - Re-checkout recreates the source file folder if it was removed too.
- Member text is now recorded at checkout and shown when you hover over a checked-out member. Existing checkouts pick it up on their next refresh.

# 1.0.3
- Added **Move Checkout Folder...** (Command Palette, or the **...** menu on the Checked Out Members panel). Pick a new folder and your existing checkouts are moved into it, the checkout index is updated to the new locations, and the **Local Folder** setting is changed for you.
  - Files with unsaved changes can be saved and moved, or left where they are.
  - If a file already exists in the new folder you choose whether to overwrite it or skip that member.
  - Open editors for moved files are reopened from the new location, and empty folders left behind are cleaned up.
  - Any member that can't be moved keeps working from its old location; details go to the **IBM i Checkout** output panel.

# 1.0.2
- Sync status is now more reliable: trailing blank lines (including lines containing only blank padding), stray carriage returns and byte-order marks are ignored when comparing local and remote source, so members no longer show as out of sync just because blank lines were added at the end.
- Existing checkouts are upgraded automatically on the next refresh, with no false conflicts from the hash change.
- Members that no longer exist on the IBM i are now flagged with a red error icon and a "remote member does not exist" description. Refresh summaries also report how many members are missing on the remote.
- Added **Re-checkout from IBM i** to the right-click menu in the checkout panel, so you can replace the local copy with the remote member without refreshing first. Supports multi-select and asks for confirmation, since local changes are discarded.
- The checkout panel is now grouped **Library → Source File → Member**, with each level collapsed by default. Libraries have their own **Refresh Remote Status** action, and **Expand All** opens both levels.
- Member paths are now read from the end, so a path with a leading iASP segment (`/ASP/LIB/FILE/MBR`) can't have its ASP name recorded as the library.

# 1.0.1
- Updated readme to include a note about changing the local folder setting to make it easier to find the checkouts folder. Also added a section about the settings for the extension.

# 1.0.0

- Initial version
