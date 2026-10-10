# Change Log

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
