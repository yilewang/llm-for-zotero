/**
 * Synthetic MinerU markdown in the shapes whose standard sections carry no
 * heading. All text is invented; none of it comes from a library.
 *
 * - `NATURE_SHAPE_MD`: a Nature-style article. Every heading is level 1:
 *   the title, then front-matter lines (DOI, dates, authors), then three
 *   unheaded paragraphs (the abstract, the bold lead, then two introduction
 *   paragraphs), topic headings that hold the results, "Discussion",
 *   "Online content", a broken heading over the reference list, "Methods".
 * - `CELL_SHAPE_MD`: a Cell-style article with a "Summary" heading for the
 *   abstract and a "Summary statistics" subsection in its methods.
 */

const sentences = (...parts: string[]) => parts.join(" ");

export const LEAD_ABSTRACT = sentences(
  "Theories of offline learning hold that the brain replays recent sensory experience during quiet rest.",
  "We imaged thousands of neurons in the visual cortex of awake mice that viewed two familiar images in a fixed order.",
  "Between images, brief bursts of activity reproduced the pattern that each image had evoked.",
  "These replays were most frequent just after an image and decayed over the following minutes.",
  "Neurons that took part in replays changed their later responses to the same image more than other neurons did.",
  "A model in which each replay nudges a response toward the replayed pattern predicted those changes day by day.",
  "Rest may therefore shape how the cortex will respond to the world.",
);

export const INTRO_SHORT = sentences(
  "In the absence of salient input, the cortex is not silent.",
  "Its spontaneous activity often resembles the activity that stimuli evoke.",
);

export const INTRO_LONG = sentences(
  "Replays, by definition, are patterns of activity that resemble earlier stimulus-evoked patterns.",
  "Earlier work found such patterns in the hippocampus during sleep and in quiet waking.",
  "Whether replays in sensory cortex change later sensory responses is not known.",
  "Here we ask whether replays predict how responses to a familiar image change across a session.",
  "We recorded large populations over several days so that each neuron could be followed.",
  "We then compared the change of each response with the replays that neuron took part in.",
  "This let us test whether replays come before the change or only follow it.",
);

export const RESULTS_A = sentences(
  "Mice viewed two images in a fixed order for one hour each day.",
  "Brief bursts of population activity between images matched the pattern of the image just shown.",
);

export const RESULTS_B = sentences(
  "Silencing the local cortex during an image removed the replays that followed it.",
  "Without replays, responses to that image stayed the same across the session.",
);

export const DISCUSSION = sentences(
  "Replays in the visual cortex may adjust later responses to familiar input.",
  "The effect was strongest for neurons that replayed most often.",
);

export const ONLINE_CONTENT =
  "Any methods, additional references, reporting summaries, source data, extended data and supplementary information";

export const REFERENCE_SPILL =
  "1. Author, A. Replay during rest. J. Example Neurosci. 1, 1–10 (2001).";

export const METHODS_TEXT =
  "All procedures followed the institutional animal care guidelines.";

export const NATURE_SHAPE_MD = [
  "# Cortical replays predict later sensory responses",
  "",
  "https://doi.org/10.1000/example.2024.0001",
  "",
  "Received: 10 October 2022",
  "",
  "Accepted: 31 October 2023",
  "",
  "Published online: 13 December 2023",
  "",
  "Check for updates",
  "",
  "Ana Author1, Ben Author2,3, Cy Author1 & Dee Author1",
  "",
  LEAD_ABSTRACT,
  "",
  INTRO_SHORT,
  "",
  INTRO_LONG,
  "",
  "# Replays spread across the visual cortex",
  "",
  RESULTS_A,
  "",
  "# Local silencing removes replays",
  "",
  RESULTS_B,
  "",
  "# Discussion",
  "",
  DISCUSSION,
  "",
  "# Online content",
  "",
  ONLINE_CONTENT,
  "",
  "# and competing interests; and statements of data and code availability are available at https://doi.org/10.1000/example.",
  "",
  REFERENCE_SPILL,
  "",
  "# Methods",
  "",
  METHODS_TEXT,
  "",
  "# Data availability",
  "",
  "The data are available from the authors.",
].join("\n");

export const CELL_SUMMARY = sentences(
  "Replays during rest shape later responses in the visual cortex.",
  "We show that each replay moves a neuron's response toward the replayed pattern.",
);

export const CELL_SUMMARY_STATISTICS =
  "Summary statistics are the mean and the standard error over mice.";

export const CELL_SHAPE_MD = [
  "# Replays shape later responses",
  "",
  "Ana Author, Ben Author",
  "",
  "# Summary",
  "",
  CELL_SUMMARY,
  "",
  "# Introduction",
  "",
  INTRO_SHORT,
  "",
  "# Results",
  "",
  RESULTS_A,
  "",
  "# Discussion",
  "",
  DISCUSSION,
  "",
  "# Method details",
  "",
  METHODS_TEXT,
  "",
  "# Summary statistics",
  "",
  CELL_SUMMARY_STATISTICS,
].join("\n");
