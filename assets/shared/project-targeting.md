## Project targeting is metadata-first

Project controls must resolve a Showtail project before they run. Treat the stable trail ID
as the identity and its current path as a validated, moveable hint.

- Never choose from the terminal working directory, workspace folder, generated chat title,
  recency, or a path produced by the model itself.
- Preserve the student's project wording when asking Showtail to resolve a target. Do not
  invent, expand, or reorder it into a filesystem path.
- Continue automatically only when Showtail returns one selected trail. If it reports an
  ambiguity, conflict, or confirmation requirement, let the student choose locally.
- Run the requested control with the selected trail ID and verify that the returned `trailId`
  and `root` still match before opening or presenting any result.
- Keep report targeting separate from edit ownership: asking for project B's report must not
  move files or captured edits away from project A.
