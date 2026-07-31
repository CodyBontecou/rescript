# ASO Audit Report

**App:** Rescript
**Primary locale:** en-US
**Metadata source:** `metadata/version/1.0.0/en-US.json`

## Field utilization

| Field | Value | Length | Limit | Usage |
| --- | --- | ---: | ---: | ---: |
| Name | Rescript: Text Video Editor | 27 | 30 | 90% |
| Subtitle | Cut Media from the Transcript | 29 | 30 | 97% |
| Keywords | transcribe,audio,cutter,trimmer,podcast,offline,speech,creator,clip,reel,shorts,voice,interview | 95 | 100 | 95% |
| Promotional text | Turn spoken words into clean cuts… | 142 | 170 | 84% |
| Description | Cut video and audio by editing the words people say… | 1,756 | 4,000 | 44% |

## Offline checks

| Check | Result | Detail |
| --- | --- | --- |
| Keyword waste | Pass | No keyword repeats a token from the name or subtitle. |
| Underutilized fields | Pass | Subtitle is 29/30 and keywords are 95/100 characters. |
| Missing fields | Pass with launch exception | Subtitle, keywords, and description are populated. Apple prohibits What’s New on the first version, so the local launch metadata intentionally omits it. |
| Keyword separators | Pass | Keywords are comma-separated with no spaces. |
| Cross-locale gaps | N/A | en-US is the only launch locale. |
| Description coverage | Pass | All 13 keyword terms appear naturally in the description. |
| Canonical validation | Pass | `asc metadata validate` reports 0 errors and 0 warnings. |

**Summary:** 0 errors, 0 warnings across 1 locale.

## Keyword gap analysis

Astro MCP is not available in this workspace and the app is not yet live/tracked, so popularity-ranked competitor gaps could not be measured. Public US App Store searches confirmed Photo & Video as the dominant category and showed strong competitive usage of video editor, maker, cut, transcript, and creator concepts. The launch metadata prioritizes the product’s differentiated transcript-led editing workflow without duplicating indexed title/subtitle terms.

## Recommendation

Ship the current launch metadata, then add Rescript to Astro after its App Store record is live. Track US rankings for transcript, transcribe, audio cutter, video trimmer, podcast editor, offline transcription, clip maker, reels, and shorts before the first metadata iteration.
