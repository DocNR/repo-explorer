feat: add result limiting to improve large repository searches

- Add maxResults parameter (default: 50) to control total number of results
- Add contextLines parameter (default: 3) to control context size per match
- Improve result sorting to prioritize files with more matches
- Add notification when results are truncated
- Update documentation with new parameter examples
- Update README to highlight new result limiting controls

These improvements prevent context window overflow when searching large
repositories like NDK or WatermelonDB, while maintaining the effectiveness
of the search by prioritizing the most relevant results first.
