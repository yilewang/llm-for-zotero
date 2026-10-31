/**
 * Upgrade fingerprints of every previously shipped text of each built-in
 * skill. Data only: `initUserSkills` (userSkills.ts) reads these lists, and
 * `scripts/compute_obsolete_hashes.mjs` checks them against git history on
 * every `npm test` and writes missing entries with `--emit`.
 *
 * A version bump of a built-in must add the previous text's hashes here, or
 * every untouched copy of that previous text stays on it as CUSTOMIZED.
 */

// Exact raw-content hashes for prior shipped versions of built-ins whose
// version increased in this release. On the first run with hash tracking, we
// only auto-upgrade when the on-disk raw file still matches a known shipped
// version; edited copies are preserved and surfaced as customized instead.
export const BUILTIN_BOOTSTRAP_RAW_HASHES: Partial<
  Record<string, ReadonlyArray<string>>
> = {
  "library-analysis.md": [
    "ftq8b2",
    "qttubn",
    "i2f8xa",
    // Released texts the list missed, from each release tag's copy
    // (v3.7.12, v3.8.5, v3.8.6, v3.8.11 and v3.8.24).
    "1gboxxt",
    "1dibsu3",
    "1fmb4jm",
    "19974y5",
    "1c3awl3",
    // v4, which named the synthesis digest the sized views omit (v5).
    "1fqhql1",
    // v5, whose context_read paging step v6 moves into context_read's
    // guidance (#541), as shipped and as the canonical copy carrying its
    // native `name:` line.
    "1nb2mr9",
    "13a396o",
    // Shipped texts the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD); "shipped" is the
    // flat file and "canonical" the copy carrying its native `name:` line.
    // v0 as released in v3.7.12–v3.7.28 (1a101c48), canonical.
    "3vee8s",
    // v1 at 739669a1, between releases, shipped.
    "1ezbia4",
    // v1 as released in v3.7.29–v3.8.4 (f8436390), canonical.
    "8g3zvd",
    // v2 as released in v3.8.5 (23ce4fc3), canonical.
    "103hhae",
    // v2 at b7508088, between releases, shipped and canonical.
    "dh214o",
    "qf2gdf",
    // v3 as released in v3.8.6–v3.8.10 (3356b556), canonical.
    "13vka0d",
    // v3 as released in v3.8.11–v3.8.23 (4e66ec97), canonical.
    "1bw9ks8",
    // v3 as released in v3.8.24–v3.9.5 (bf22bc2b), canonical.
    "yx37ia",
    // v4 at ad2c0fec, between releases, canonical.
    "1de1jfk",
  ],
  "compare-papers.md": [
    "i0j6yq",
    "1yreksb",
    "7os2qk",
    "1frgnyh",
    "1jvl4lu",
    "cp9zod",
    "w9wsrp",
    "1w3ytrp",
    "1krlubq",
    "6upxur",
    "qs8z4b",
    "ulypcf",
    // Both parallel v8 texts (main and the tool-consolidation branch).
    "jch7ho",
    "11c76b5",
    // v9, the text v10's digest part extends, as shipped and as the
    // canonical copy carrying its native `name:` line.
    "l93iop",
    "jop719",
    // v10, the text v11's dimension-named digest replaces, as shipped and
    // as the canonical copy carrying its native `name:` line.
    "1mp6wjc",
    "1a6j60s",
    // v11, whose task_update digest step v12 moves into task_update's
    // guidance (#541), as shipped and as the canonical copy carrying its
    // native `name:` line.
    "ngexre",
    "1m607zi",
    // v12, whose reading v13 makes follow what the user asked to read (only
    // the abstracts, named sections, or full reads), as shipped and as the
    // canonical copy carrying its native `name:` line.
    "xytjpv",
    "urjtw7",
    // Shipped texts the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD); "shipped" is the
    // flat file and "canonical" the copy carrying its native `name:` line.
    // v0 as released in v3.7.12 (1a101c48), canonical.
    "15elzly",
    // v0 as released in v3.7.13–v3.7.17 (b88523fd), canonical.
    "1cnd6in",
    // v0 as released in v3.7.18–v3.7.28 (cee35682), canonical.
    "50bkkg",
    // v1 as released in v3.7.29–v3.8.4 (f8436390), canonical.
    "14n5lee",
    // v2 as released in v3.8.5 (23ce4fc3), canonical.
    "1o2fn4x",
    // v3 at b7508088, between releases, canonical.
    "12evqcp",
    // v4 at 02c767f9, between releases, canonical.
    "1pd5su1",
    // v5 as released in v3.8.6–v3.8.11 (3356b556), canonical.
    "1efvsqy",
    // v6 as released in v3.8.12 (07ef22e1), shipped and canonical.
    "ni9oev",
    "1ircw2j",
    // v6 as released in v3.8.13–v3.8.18 (d5907110), shipped and canonical.
    "1b68fkr",
    "55u5en",
    // v6 as released in v3.8.19 (37263f10), shipped and canonical.
    "595yp0",
    "1up5nxk",
    // v6 at ffb1ad1b, between releases, shipped and canonical.
    "1a17tfe",
    "syakla",
    // v6 as released in v3.8.20–v3.8.21 (cad5dbe1), shipped and canonical.
    "4ikuqa",
    "1cfbf2u",
    // v6 as released in v3.8.22 (a6c38ba2), shipped and canonical.
    "1b7hl3z",
    "1l7t1nn",
    // v6 as released in v3.8.23 (a364f4f9), shipped and canonical.
    "1bvagb",
    "14y1wz3",
    // v6 as released in v3.8.24–v3.9.3 (bf22bc2b), canonical.
    "1s3ai7b",
    // v7 as released in v3.9.4–v3.9.5 (d8ad481d), shipped and canonical.
    "12exhei",
    "x1hase",
    // v8 at ad2c0fec, between releases, canonical.
    "wg5z5c",
    // v8 at 6d322998, between releases, canonical.
    "1nc3wl1",
  ],
  "analyze-figures.md": [
    "msvqtf",
    "17o1bpl",
    "gdr4uu",
    "1kjl8up",
    "e0ebpu",
    "z5uzar",
    "1u0n8ze",
    // Shipped texts the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD); "shipped" is the
    // flat file and "canonical" the copy carrying its native `name:` line.
    // v0 as released in v3.7.16–v3.7.17 (631a3c3b), shipped and canonical.
    "1e16cle",
    "135v7vh",
    // v0 as released in v3.7.18–v3.7.21 (cee35682), shipped and canonical.
    "16blflv",
    "gnmp8e",
    // v0 as released in v3.7.22–v3.7.27 (362dcbdb), shipped and canonical.
    "11pj7qm",
    "1nzhd61",
    // v0 as released in v3.7.28 (e0bff997), shipped and canonical.
    "81y1q0",
    "fmw64z",
    // v1 at 739669a1, between releases, shipped.
    "1yn14a9",
    // v1 as released in v3.7.29–v3.7.31 (f8436390), canonical.
    "1yrhfpa",
    // v2 as released in v3.7.32–v3.8.4 (5e473125), canonical.
    "1vqkdz8",
    // v3 as released in v3.8.5 (23ce4fc3), shipped and canonical.
    "s4ewwr",
    "toz1jq",
    // v3 at b7508088, between releases, shipped and canonical.
    "fui4i5",
    "1t5xevc",
    // v4 as released in v3.8.6–v3.8.19 (3356b556), shipped and canonical.
    "1f3ngww",
    "1ulfpnf",
    // v4 as released in v3.8.20–v3.8.22 (7fe3b203), shipped and canonical.
    "hoshk8",
    "1o63q1v",
    // v4 at 851747c6, between releases, shipped and canonical.
    "e4jum9",
    "1brpyv0",
    // v4 at 6e1b9cf6, between releases, shipped and canonical.
    "1jyjfdw",
    "1dlzim7",
    // v4 at 53d2fa7c, between releases, shipped and canonical.
    "yvn92d",
    "mm4u74",
    // v4 at 3d28ab18, between releases, shipped and canonical.
    "i278as",
    "1xj6wn3",
    // v4 at 552ffabb, between releases, shipped and canonical.
    "1he6c7f",
    "18d970m",
    // v4 as released in v3.8.23–v3.9.5 (7e7dc67a), shipped and canonical.
    "ks8szm",
    "5mu3kt",
    // v5 at 9271b67b, between releases, shipped and canonical.
    "7czee8",
    "17fv0bf",
    // v6 as released in v3.9.6 (b2ed3f30), shipped and canonical.
    "1kyu0jt",
    "1tezin8",
    // v7 as released in v3.9.7 (0ca9b5b2), shipped and canonical.
    "16xag2g",
    "1muiq1f",
    // v10 at ad2c0fec, between releases, canonical.
    "x91x1q",
    // v10 at 2e9bb879, between releases, canonical.
    "17qzhal",
    // v11 at 4c20d86d, between releases, canonical.
    "anx7h1",
  ],
  "evidence-based-qa.md": [
    "en0khz",
    "vyeyap",
    "1vhakii",
    "dxw5b3",
    "11cbpv7",
    "1er2ubr",
    "13esvqx",
    "1k39b46",
    "1xglfq0",
    "qdqcm0",
    "90zxig",
    "5iibf",
    "1qkh4mt",
    "14eowou",
    "1l2klni",
    "37vjex",
    // v12, the text v13's lookup-first route and absence distinction
    // replace, as shipped and as the canonical copy carrying its native
    // `name:` line.
    "mlbz5s",
    "1psjdpv",
    // Shipped texts the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD); "shipped" is the
    // flat file and "canonical" the copy carrying its native `name:` line.
    // v0 at 6d21a1c4, between releases, canonical.
    "8n9it0",
    // v0 as released in v3.7.18–v3.7.28 (cee35682), canonical.
    "1vrrkbx",
    // v1 as released in v3.7.29–v3.7.31 (f8436390), canonical.
    "1b7m3za",
    // v1 as released in v3.7.32–v3.8.4 (37ff9f94), canonical.
    "z242i",
    // v2 as released in v3.8.5 (23ce4fc3), canonical.
    "1y5qfrg",
    // v2 at b7508088, between releases, canonical.
    "lhvb4p",
    // v3 as released in v3.8.6–v3.8.11 (3356b556), canonical.
    "ewxibv",
    // v4 as released in v3.8.12 (07ef22e1), shipped and canonical.
    "8cag34",
    "nmwpc3",
    // v4 as released in v3.8.13–v3.8.18 (d5907110), shipped and canonical.
    "dt0rbb",
    "18gf35m",
    // v4 as released in v3.8.19 (37263f10), shipped and canonical.
    "fe0r1z",
    "12clde2",
    // v4 at ffb1ad1b, between releases, shipped and canonical.
    "1nh80fh",
    "jq35gg",
    // v4 as released in v3.8.20–v3.8.21 (cad5dbe1), shipped and canonical.
    "12yl3at",
    "xd45m0",
    // v4 as released in v3.8.22 (a6c38ba2), shipped and canonical.
    "11w5fkf",
    "i81x6q",
    // v4 as released in v3.8.23 (a364f4f9), shipped and canonical.
    "hvszq3",
    "3s44r2",
    // v4 as released in v3.8.24–v3.9.3 (bf22bc2b), canonical.
    "1hpv03v",
    // v5 as released in v3.9.4–v3.9.5 (d8ad481d), shipped and canonical.
    "1c6hdbb",
    "1gj38yi",
    // v6 at 9271b67b, between releases, shipped and canonical.
    "m4x6fx",
    "ke28cw",
    // v7 at 56463bb1, between releases, shipped and canonical.
    "1hdos1e",
    "12xc7j9",
    // v7 as released in v3.9.6–v3.9.8 (b2ed3f30), canonical.
    "1f2g4je",
    // v9 at ad2c0fec, between releases, canonical.
    "1g9yv75",
    // v9 at 6d322998, between releases, canonical.
    "ko5si0",
    // v10 at 519bea63, between releases, canonical.
    "15k46k1",
    // v11 at bf85669d, between releases, canonical.
    "93c98c",
  ],
  "write-note.md": [
    "172xn8t",
    "nvca0f",
    "17lvl1z",
    "u1ej3e",
    "1c1s5yg",
    "1cfk2wb",
    "3m65z4",
    // v18, whose context_read source step v19 moves into context_read's
    // guidance (#541), as shipped and as the canonical copy carrying its
    // native `name:` line.
    "1kxggv",
    "xw13m",
    // Shipped texts the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD); "shipped" is the
    // flat file and "canonical" the copy carrying its native `name:` line.
    // v5 at 5e473125, between releases, shipped and canonical.
    "9ifxxt",
    "1gu06ro",
    // v5 as released in v3.7.32–v3.8.1 (37ff9f94), shipped and canonical.
    "8im2r0",
    "1nktpkv",
    // v5 as released in v3.8.2–v3.8.4 (11cc9951), canonical.
    "3x4y5c",
    // v6 as released in v3.8.5 (23ce4fc3), shipped and canonical.
    "zwius4",
    "yxfc87",
    // v6 at b7508088, between releases, shipped and canonical.
    "10q8cbl",
    "jykyic",
    // v7 at 3356b556, between releases, shipped and canonical.
    "w48fpx",
    "s25g20",
    // v7 as released in v3.8.6–v3.8.9 (a6fb4cfa), shipped and canonical.
    "d7h9kd",
    "12emqu8",
    // v7 as released in v3.8.10 (d4d54d02), shipped and canonical.
    "6mshrb",
    "1s1skt6",
    // v7 as released in v3.8.11–v3.8.22 (4e66ec97), shipped and canonical.
    "dh5i9n",
    "3dl12m",
    // v7 at 851747c6, between releases, shipped and canonical.
    "yijq0a",
    "1ewp9q5",
    // v7 at 6e1b9cf6, between releases, shipped and canonical.
    "rpm9xl",
    "11jph5o",
    // v7 at 53d2fa7c, between releases, shipped and canonical.
    "spzz33",
    "k0muya",
    // v7 at 552ffabb, between releases, shipped and canonical.
    "17p40fo",
    "isew1z",
    // v7 at 7e7dc67a, between releases, shipped and canonical.
    "1jdutd2",
    "ap75i1",
    // v7 as released in v3.8.23 (3131bd1b), shipped and canonical.
    "1eqvc35",
    "1qrwe1w",
    // v7 as released in v3.8.24–v3.8.25 (bf22bc2b), shipped and canonical.
    "11r8huv",
    "wkyupm",
    // v7 as released in v3.8.26–v3.8.37 (785f6855), canonical.
    "ip2mv6",
    // v8 at f81ca8df, between releases, shipped and canonical.
    "11tf0nf",
    "10msyny",
    // v9 as released in v3.9.0–v3.9.5 (28f396ac), shipped and canonical.
    "ys9ojp",
    "1pp9o3c",
    // v10 as released in v3.9.6 (b2ed3f30), shipped and canonical.
    "1mbj2zg",
    "ozc7tb",
    // v11 at 0ca9b5b2, between releases, shipped and canonical.
    "lhf8tk",
    "1ogg7wb",
    // v12 at a76ce64d, between releases, shipped and canonical.
    "fgnjhz",
    "14kyf7u",
    // v13 as released in v3.9.7 (62bf720c), shipped and canonical.
    "6uuyvc",
    "1fqtrdn",
    // v16 at 8b39ce80, between releases, canonical.
    "1uua6hn",
    // v16 at ad2c0fec, between releases, canonical.
    "11r9hjy",
    // v17 at 2e9bb879, between releases, canonical.
    "11pzjw3",
    // v18 at 25368e4d, between releases, shipped and canonical.
    "1cvq3mj",
    "3f0hf2",
  ],
  "literature-review.md": [
    "kbrknh",
    "nxpr5d",
    "1cnjf9i",
    "3tk61l",
    "1ptwzpw",
    "pefrjt",
    "fptven",
    "10fqwsh",
    // Released texts the list missed, from each release tag's copy
    // (v3.7.18 to v3.9.5).
    "1gbl57m",
    "n96aqu",
    "w18p0a",
    "1dbaw6y",
    "1ymizha",
    "1mwckog",
    "au1hm1",
    "y7vpt5",
    "q3t63g",
    "fjgktb",
    // v10, the investigation-loop text the ordinary v11 replaces.
    "liv5sv",
    // v11, the text v12's digest parts replace, as shipped and as the
    // canonical copy carrying its native `name:` line.
    "1hrhlxd",
    "3mijhi",
    // v12, the text v13's question-led digest and Select step replace, as
    // shipped and as the canonical copy carrying its native `name:` line.
    "mujbgx",
    "18cssl2",
    // v13 (v3.9.10 to v3.9.12), the text v14's nothing-relevant rule (find
    // papers through the selection card, never review outside abstracts)
    // extends, as shipped and as the canonical copy carrying its native
    // `name:` line.
    "15xumq",
    "1rape47",
    // v14, whose task_update parts, digest and retry steps v15 moves into
    // task_update's guidance (#541), as shipped and as the canonical copy
    // carrying its native `name:` line.
    "kl1d3v",
    "b7qleo",
    // v15, whose submit_document step v16 leaves to submit_document's
    // description, as shipped and as the canonical copy carrying its native
    // `name:` line.
    "xfd5wu",
    "17ofyyb",
    // v16, whose never-review-outside-abstracts rule v17 replaces with the
    // selection card's choice to import and cite or cite without importing,
    // as shipped and as the canonical copy carrying its native `name:` line.
    "16809kz",
    "1488enc",
    // v17, whose coverage line v18 counts a paper as read in full only when
    // its reader read every character (a digest's Full, a complete full
    // paper_read), as shipped and as the canonical copy carrying its native
    // `name:` line.
    "127dobw",
    "1al1wxd",
    // v18, whose Read step v19 words as reading the sections a sampled paper
    // did not return (not sections the paper lacks), as shipped and as the
    // canonical copy carrying its native `name:` line.
    "kj0v8e",
    "evtk2r",
    // Shipped texts the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD); "shipped" is the
    // flat file and "canonical" the copy carrying its native `name:` line.
    // v0 at cee35682, between releases, shipped and canonical.
    "zmxuhr",
    "1h346ro",
    // v0 as released in v3.7.18–v3.7.28 (f1298d3a), canonical.
    "19r1qef",
    // v1 at 739669a1, between releases, shipped.
    "fjov0l",
    // v1 as released in v3.7.29–v3.8.4 (f8436390), canonical.
    "1usmx82",
    // v2 as released in v3.8.5 (23ce4fc3), canonical.
    "eabh0r",
    // v2 at b7508088, between releases, shipped and canonical.
    "1xznfws",
    "1pq3elt",
    // v3 as released in v3.8.6–v3.8.10 (3356b556), canonical.
    "7n1k3j",
    // v3 as released in v3.8.11–v3.8.12 (4e66ec97), canonical.
    "20sngf",
    // v3 as released in v3.8.13–v3.8.18 (d5907110), canonical.
    "4mdw1v",
    // v3 as released in v3.8.19 (37263f10), canonical.
    "jl4b5h",
    // v3 as released in v3.8.20–v3.8.21 (cad5dbe1), canonical.
    "1665gjy",
    // v3 as released in v3.8.22 (a6c38ba2), canonical.
    "1gyy0zy",
    // v3 at 53d2fa7c, between releases, shipped and canonical.
    "o2mmx1",
    "cnk88a",
    // v3 at a364f4f9, between releases, shipped and canonical.
    "zs8mkx",
    "17sr9o6",
    // v3 as released in v3.8.23 (7e7dc67a), canonical.
    "1bzbbc1",
    // v3 as released in v3.8.24–v3.9.3 (bf22bc2b), canonical.
    "17bnjrq",
    // v4 at d8ad481d, between releases, shipped and canonical.
    "uupm2x",
    "11yxdv2",
    // v4 as released in v3.9.4–v3.9.5 (62be1eff), canonical.
    "3kt03o",
    // v5 at 867fe6c6, between releases, shipped and canonical.
    "5aywee",
    "378udn",
    // v5 at 5e3bb2e1, between releases, shipped and canonical.
    "fzdpsj",
    "1neqtfc",
    // v6 at 40c5c1b2, between releases, shipped and canonical.
    "ed8hkk",
    "kvtol5",
    // v6 at b2ed3f30, between releases, canonical.
    "1b0of8r",
    // v7 at 278ac601, between releases, canonical.
    "1dgtnry",
    // v9 at 51d146f5, between releases, canonical.
    "39nzfq",
    // v9 at ad2c0fec, between releases, canonical.
    "mekih0",
    // v10 at 8dc332b3, between releases, canonical.
    "1eo10dg",
    // v12 at 7bed2e5f, between releases, shipped and canonical.
    "1u0r0w6",
    "k9bkln",
    // v13 at 2f176cb0, between releases, shipped and canonical.
    "atbh15",
    "aasza6",
    // v13 at c95744f1, between releases, shipped and canonical.
    "1pqlpvh",
    "umfnia",
    // v13 at 79c4031b, between releases, shipped and canonical.
    "1cwfa3g",
    "dzvaht",
    // v13 at 7c7c1de5, between releases, shipped and canonical.
    "jyeij1",
    "ozbspe",
    // v13 at 9a1d467e, between releases, shipped and canonical.
    "110onaf",
    "cv7ess",
    // v13 at 43512119, between releases, shipped and canonical.
    "vq6cw5",
    "zpd70q",
    // v17 at d0d57751, not yet released, shipped and canonical.
    "17f0iwx",
    "1uu46cm",
    // v18 at af06d08e, not yet released, shipped and canonical.
    "esclmu",
    "s7ryx7",
    // v19 at 656ae86d, not yet released, shipped and canonical.
    "xmse2w",
    "12lovbh",
    // v20 at 72929c73, not yet released, shipped and canonical.
    "iqopc2",
    "1sf2d47",
  ],
  "reorganize-library.md": [
    // v1, whose task_update part v2 moves into task_update's guidance
    // (#541), as shipped and as the canonical copy carrying its native
    // `name:` line.
    "1nlucw4",
    "1jwuu81",
    // v2, whose never-a-full-text rule v3 leaves to the user (a full text,
    // or every paper, when the user asks), as shipped and as the canonical
    // copy carrying its native `name:` line.
    "9pqjhh",
    "1hpk276",
    // Shipped texts the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD); "shipped" is the
    // flat file and "canonical" the copy carrying its native `name:` line.
    // v1 at d412a9a0, between releases, shipped and canonical.
    "1j833mq",
    "q5dw67",
    // v1 at 890590ac, between releases, shipped and canonical.
    "d6ng6",
    "1v5l4k3",
  ],
  "import-cited-reference.md": [
    "19bomz1",
    "e9tjej",
    "145es7h",
    "1j1qzbc",
    "1sx03p9",
    "1mtgn5u",
    // v6, whose web_read page step v7 moves into web_read's guidance
    // (#541), as shipped and as the canonical copy carrying its native
    // `name:` line.
    "iryqnj",
    "qquewx",
    // Shipped texts the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD); "shipped" is the
    // flat file and "canonical" the copy carrying its native `name:` line.
    // v0 as released in v3.7.22–v3.7.28 (362dcbdb), shipped and canonical.
    "g5l073",
    "3n6yhd",
    // v1 at 739669a1, between releases, shipped.
    "7hsj4f",
    // v1 as released in v3.7.29–v3.8.4 (f8436390), canonical.
    "1gl45i7",
    // v2 as released in v3.8.5 (23ce4fc3), shipped and canonical.
    "hk11g3",
    "1xf1mxx",
    // v2 at b7508088, between releases, shipped and canonical.
    "135as4v",
    "12780u9",
    // v3 as released in v3.8.6–v3.8.12 (3356b556), shipped and canonical.
    "ecxoxv",
    "7b2o45",
    // v3 as released in v3.8.13–v3.8.26 (23b6262e), shipped and canonical.
    "7l9bkw",
    "fcq9ki",
    // v3 as released in v3.8.27–v3.9.5 (dc3eedd2), shipped and canonical.
    "e9x7dm",
    "nbc4rw",
    // v4 at af67d711, between releases, canonical.
    "1w0463e",
    // v4 at ad2c0fec, between releases, canonical.
    "1lnnpjj",
    // v5 at 85e8a9a2, between releases, canonical.
    "wjvzf8",
  ],
  "zotero-script.md": [
    // Shipped texts the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD); "shipped" is the
    // flat file and "canonical" the copy carrying its native `name:` line.
    // v1 at 1e89fa5b, not yet released, shipped and canonical.
    "11tae4h",
    "rfiqsr",
    // v1 at 706c0491, not yet released, shipped and canonical.
    "12oq4et",
    "1vo3zsv",
  ],
};

// Upgrade hashes (`hashSkillForUpgrade`: the managed block, else the body) of
// every previously shipped version of each built-in. A stored hash is the
// plugin's only if it is one of these: the first start without a stored hash
// also tracks a copy it could not identify (an edit), and that tracked copy
// must stay the user's on every later start. A body listed here also lets
// that first start upgrade a copy whose frontmatter alone differs.
export const BUILTIN_BOOTSTRAP_BODY_HASHES: Partial<
  Record<string, ReadonlyArray<string>>
> = {
  "compare-papers.md": [
    "x00ci1",
    "1au58pu",
    "13ppssj",
    "19kyxys",
    "spgyhq",
    "17c7wx5",
    "6r67g8",
    "1j5fq18",
    "1t8gyg9",
    "7cp6rj",
    // Both parallel v8 bodies (main and the tool-consolidation branch).
    "1eveisf",
    "8zlow4",
    // v9, the body v10's digest part extends.
    "1s8bw97",
    // v10, the body v11's dimension-named digest replaces.
    "dds2si",
    // v11, the body whose task_update digest step v12 moves into
    // task_update's guidance (#541).
    "e98t03",
    // v12, the body whose reading v13 makes follow what the user asked to
    // read.
    "ihlct7",
    // Shipped bodies the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD).
    // v6 as released in v3.8.12 (07ef22e1).
    "10bzlel",
    // v6 as released in v3.8.13–v3.8.18 (d5907110).
    "yha6jl",
    // v6 as released in v3.8.19 (37263f10).
    "11fr4i2",
    // v6 at ffb1ad1b, between releases.
    "1p9xi8w",
    // v6 as released in v3.8.20–v3.8.21 (cad5dbe1).
    "125cewo",
    // v6 as released in v3.8.22 (a6c38ba2).
    "v2rj39",
    // v6 as released in v3.8.23 (a364f4f9).
    "1bkive9",
  ],
  "evidence-based-qa.md": [
    "41yh3d",
    "1aby95d",
    "1g0a76y",
    "4gj0dx",
    "12qgkrq",
    "bgr2hf",
    "zjwar9",
    "49orr",
    "13yvvl6",
    "1l4p1x2",
    "u49rr3",
    // v12, the body v13's lookup-first route replaces.
    "7fiyr0",
    // Shipped bodies the list missed, from scripts/compute_obsolete_hashes.mjs
    // (every text in the history of a release tag or HEAD).
    // v4 as released in v3.8.12 (07ef22e1).
    "1glg5sv",
    // v4 as released in v3.8.13–v3.8.18 (d5907110).
    "15blu7q",
    // v4 as released in v3.8.19 (37263f10).
    "40z8hy",
    // v4 at ffb1ad1b, between releases.
    "6fhy4",
    // v4 as released in v3.8.20–v3.8.21 (cad5dbe1).
    "y0iuck",
    // v4 as released in v3.8.22 (a6c38ba2).
    "yorigu",
    // v4 as released in v3.8.23 (a364f4f9).
    "189lze",
    // v5 as released in v3.9.4–v3.9.5 (d8ad481d); at 9271b67b, between releases.
    "1ajv9md",
  ],
  "analyze-figures.md": [
    // Every shipped body but the current one, from
    // scripts/compute_obsolete_hashes.mjs (every text in the history of a
    // release tag or HEAD).
    // v0 as released in v3.7.16–v3.7.17 (631a3c3b).
    "sal83r",
    // v0 as released in v3.7.18–v3.7.21 (cee35682).
    "a59f0o",
    // v0 as released in v3.7.22–v3.7.27 (362dcbdb).
    "5cg1hv",
    // v0 as released in v3.7.28 (e0bff997).
    "uaznjx",
    // v1 at 739669a1, between releases; as released in v3.7.29–v3.7.31 (f8436390).
    "14x9wof",
    // v2 as released in v3.7.32–v3.8.4 (5e473125).
    "1lgglis",
    // v3 as released in v3.8.5 (23ce4fc3).
    "e3bjnp",
    // v3 at b7508088, between releases; as released in v3.8.6–v3.8.19 (3356b556).
    "1utz3g7",
    // v4 as released in v3.8.20–v3.8.22 (7fe3b203).
    "u4en9b",
    // v4 at 851747c6, between releases.
    "1wno8fs",
    // v4 at 6e1b9cf6, between releases.
    "lm1nbv",
    // v4 at 53d2fa7c, between releases.
    "rpka8s",
    // v4 at 3d28ab18, between releases.
    "d57zob",
    // v4 at 552ffabb, between releases.
    "a1lxmq",
    // v4 as released in v3.8.23–v3.9.5 (7e7dc67a); at 9271b67b, between releases.
    "l8vnzt",
    // v6 as released in v3.9.6 (b2ed3f30).
    "1w9n3lr",
    // v7 as released in v3.9.7 (0ca9b5b2).
    "yzxr71",
    // v9 as released in v3.9.8–v3.9.9 (0e7936ca).
    "11d2vz5",
    // v10 at ad2c0fec, between releases.
    "1h3eb3q",
    // v10 at 2e9bb879, between releases; at 4c20d86d, between releases.
    "1nv7jv9",
  ],
  "import-cited-reference.md": [
    // Every shipped body but the current one, from
    // scripts/compute_obsolete_hashes.mjs (every text in the history of a
    // release tag or HEAD).
    // v0 as released in v3.7.22–v3.7.28 (362dcbdb).
    "1iv2zu4",
    // v1 at 739669a1, between releases; as released in v3.7.29–v3.8.4 (f8436390).
    "a08wkw",
    // v2 as released in v3.8.5 (23ce4fc3).
    "1ietg8l",
    // v2 at b7508088, between releases; as released in v3.8.6–v3.8.12 (3356b556).
    "dmsh1t",
    // v3 as released in v3.8.13–v3.8.26 (23b6262e).
    "1rivjm6",
    // v3 as released in v3.8.27–v3.9.5 (dc3eedd2); as released in v3.9.6–v3.9.9 (b2ed3f30).
    "u3vs08",
    // v4 at af67d711, between releases.
    "u91fmc",
    // v4 at ad2c0fec, between releases.
    "16jq3xl",
    // v5 at 85e8a9a2, between releases.
    "1trpmzx",
    // v6 as released in v3.9.10–v3.9.15 (8dc332b3).
    "1dhdiu1",
  ],
  "library-analysis.md": [
    // Every shipped body but the current one, from
    // scripts/compute_obsolete_hashes.mjs (every text in the history of a
    // release tag or HEAD).
    // v0 as released in v3.7.12–v3.7.28 (1a101c48).
    "1cfazxs",
    // v1 at 739669a1, between releases; as released in v3.7.29–v3.8.4 (f8436390).
    "1lxfpen",
    // v2 as released in v3.8.5 (23ce4fc3).
    "1uyoiaz",
    // v2 at b7508088, between releases; as released in v3.8.6–v3.8.10 (3356b556).
    "16c6amg",
    // v3 as released in v3.8.11–v3.8.23 (4e66ec97).
    "1rd3ncj",
    // v3 as released in v3.8.24–v3.9.5 (bf22bc2b); as released in v3.9.6–v3.9.9 (b2ed3f30).
    "1kczskd",
    // v4 at ad2c0fec, between releases.
    "pi7e6",
    // v5 as released in v3.9.10–v3.9.15 (55ee8601).
    "1042wst",
  ],
  "literature-review.md": [
    // Every shipped body but the current one, from
    // scripts/compute_obsolete_hashes.mjs (every text in the history of a
    // release tag or HEAD).
    // v0 at cee35682, between releases.
    "1rcpecq",
    // v0 as released in v3.7.18–v3.7.28 (f1298d3a).
    "qho5kd",
    // v1 at 739669a1, between releases; as released in v3.7.29–v3.8.4 (f8436390).
    "qiaelz",
    // v2 as released in v3.8.5 (23ce4fc3).
    "11o6usv",
    // v2 at b7508088, between releases.
    "1b36379",
    // v3 as released in v3.8.6–v3.8.10 (3356b556).
    "1l56cws",
    // v3 as released in v3.8.11–v3.8.12 (4e66ec97).
    "1epin98",
    // v3 as released in v3.8.13–v3.8.18 (d5907110).
    "ql59c",
    // v3 as released in v3.8.19 (37263f10).
    "8ar8he",
    // v3 as released in v3.8.20–v3.8.21 (cad5dbe1).
    "skd32j",
    // v3 as released in v3.8.22 (a6c38ba2).
    "12242q3",
    // v3 at 53d2fa7c, between releases.
    "1qh6jjb",
    // v3 at a364f4f9, between releases.
    "p2v4qb",
    // v3 as released in v3.8.23 (7e7dc67a).
    "nns5ni",
    // v3 as released in v3.8.24–v3.9.3 (bf22bc2b).
    "1suxl3n",
    // v4 at d8ad481d, between releases.
    "826c22",
    // v4 as released in v3.9.4–v3.9.5 (62be1eff).
    "z47iu8",
    // v5 at 867fe6c6, between releases.
    "196ug5i",
    // v5 at 5e3bb2e1, between releases.
    "1jzna9f",
    // v6 at 40c5c1b2, between releases; at b2ed3f30, between releases.
    "1723u43",
    // v7 at 278ac601, between releases.
    "1gitslh",
    // v8 as released in v3.9.6–v3.9.9 (0db94367).
    "1n72o8v",
    // v9 at 51d146f5, between releases.
    "1g2fsb",
    // v9 at ad2c0fec, between releases.
    "1cy02x",
    // v10 at 8dc332b3, between releases.
    "pnbdt",
    // v11 at abba80c5, between releases.
    "87ir9e",
    // v12 at 7bed2e5f, between releases.
    "mmv7fq",
    // v12 at 11396e40, between releases.
    "c5o0k1",
    // v13 at 2f176cb0, between releases.
    "ne3l2w",
    // v13 at c95744f1, between releases.
    "l5spzw",
    // v13 at 79c4031b, between releases.
    "1a2v7bv",
    // v13 at 7c7c1de5, between releases.
    "1leb6r0",
    // v13 at 9a1d467e, between releases.
    "1th2yu",
    // v13 at 43512119, between releases.
    "pzo7ms",
    // v13 as released in v3.9.10–v3.9.12 (f97b10e1).
    "eb0k8h",
    // v14 as released in v3.9.13–v3.9.15 (722903bb).
    "17z4ijd",
    // v15 at 31b50ae4, not yet released.
    "n8r163",
    // v16 at 432d24fc, not yet released.
    "1fbr2yn",
    // v17 at d0d57751, not yet released.
    "6agvw",
    // v17 at 9e66e82b, not yet released.
    "43lgn",
    // v18 at af06d08e, not yet released.
    "1fd45i8",
    // v18 at 4d553b8b, not yet released.
    "1yshcoo",
    // v19 at 656ae86d, not yet released.
    "ipb329",
    // v20 at 72929c73, not yet released.
    "7u5lz7",
  ],
  "reorganize-library.md": [
    // Every shipped body but the current one, from
    // scripts/compute_obsolete_hashes.mjs (every text in the history of a
    // release tag or HEAD).
    // v1 at d412a9a0, between releases.
    "12go4xr",
    // v1 at 890590ac, between releases.
    "mxbwf6",
    // v1 as released in v3.9.10–v3.9.15 (db3ef1e0).
    "ab04fk",
    // v2 at 31b50ae4, not yet released.
    "1xoq9g0",
  ],
  "write-note.md": [
    // Every shipped body but the current one, from
    // scripts/compute_obsolete_hashes.mjs (every text in the history of a
    // release tag or HEAD).
    // v5 at 5e473125, between releases; as released in v3.7.32–v3.8.1 (37ff9f94).
    "k96mrw",
    // v5 as released in v3.8.2–v3.8.4 (11cc9951).
    "1mmoppp",
    // v6 as released in v3.8.5 (23ce4fc3).
    "19byfn",
    // v6 at b7508088, between releases; at 3356b556, between releases.
    "k7sqe8",
    // v7 as released in v3.8.6–v3.8.9 (a6fb4cfa).
    "qzruew",
    // v7 as released in v3.8.10 (d4d54d02).
    "ydaeq",
    // v7 as released in v3.8.11–v3.8.22 (4e66ec97).
    "1iy5mme",
    // v7 at 851747c6, between releases.
    "u1kd85",
    // v7 at 6e1b9cf6, between releases.
    "j4jgt0",
    // v7 at 53d2fa7c, between releases.
    "ey0sbu",
    // v7 at 552ffabb, between releases.
    "1cbq5z3",
    // v7 at 7e7dc67a, between releases.
    "b54aep",
    // v7 as released in v3.8.23 (3131bd1b).
    "sdd798",
    // v7 as released in v3.8.24–v3.8.25 (bf22bc2b).
    "zx9i7m",
    // v7 as released in v3.8.26–v3.8.37 (785f6855).
    "1cmgywq",
    // v8 at f81ca8df, between releases.
    "jhgkr9",
    // v9 as released in v3.9.0–v3.9.5 (28f396ac).
    "red1fi",
    // v10 as released in v3.9.6 (b2ed3f30).
    "3mq6b9",
    // v11 at 0ca9b5b2, between releases.
    "x3wqdc",
    // v12 at a76ce64d, between releases.
    "za46vi",
    // v13 as released in v3.9.7 (62bf720c).
    "5oxvj2",
    // v15 as released in v3.9.8–v3.9.9 (0e7936ca).
    "tsuw9g",
    // v16 at 8b39ce80, between releases.
    "jry2s",
    // v16 at ad2c0fec, between releases.
    "ulugb2",
    // v17 at 2e9bb879, between releases.
    "wsz3qz",
    // v18 as released in v3.9.10–v3.9.15 (8dc332b3, ff7b0509).
    "gx6vcw",
    // v18 at 25368e4d, between releases.
    "s6xh6k",
  ],
  "zotero-script.md": [
    // Every shipped body but the current one, from
    // scripts/compute_obsolete_hashes.mjs (every text in the history of a
    // release tag or HEAD).
    // v1 at 1e89fa5b, not yet released.
    "1ldbqwu",
    // v1 at 706c0491, not yet released.
    "m6b6j6",
  ],
};
