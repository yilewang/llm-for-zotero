/**
 * The English Porter stemmer (M.F. Porter, "An algorithm for suffix
 * stripping", Program 14(3), 1980), written out by hand so retrieval needs no
 * dependency. It follows Porter's own reference implementation, which differs
 * from the paper in two documented rules: step 2 maps "-bli" (not only
 * "-abli") to "-ble", and adds "-logi" → "-log".
 *
 * Input is one lowercase ASCII word ([a-z]+). Words of one or two letters are
 * returned unchanged, as in the reference. The output is an index term, not a
 * word ("happy" → "happi"): never show it to a reader.
 */

const VOWELS = "aeiou";

export function porterStem(word: string): string {
  if (word.length <= 2) return word;
  const b = word.split("");
  let k = b.length - 1;
  let j = 0;

  /** True when b[i] is a consonant; "y" is one unless a consonant precedes it. */
  const cons = (i: number): boolean => {
    const ch = b[i];
    if (VOWELS.includes(ch)) return false;
    if (ch === "y") return i === 0 ? true : !cons(i - 1);
    return true;
  };

  /** The measure m of b[0..j]: the number of vowel-consonant sequences. */
  const m = (): number => {
    let n = 0;
    let i = 0;
    while (true) {
      if (i > j) return n;
      if (!cons(i)) break;
      i += 1;
    }
    i += 1;
    while (true) {
      while (true) {
        if (i > j) return n;
        if (cons(i)) break;
        i += 1;
      }
      i += 1;
      n += 1;
      while (true) {
        if (i > j) return n;
        if (!cons(i)) break;
        i += 1;
      }
      i += 1;
    }
  };

  const vowelInStem = (): boolean => {
    for (let i = 0; i <= j; i += 1) if (!cons(i)) return true;
    return false;
  };

  /** b[i-1..i] is a double consonant. */
  const doubleC = (i: number): boolean =>
    i >= 1 && b[i] === b[i - 1] && cons(i);

  /** b[i-2..i] is consonant-vowel-consonant and b[i] is not w, x or y. */
  const cvc = (i: number): boolean => {
    if (i < 2 || !cons(i) || cons(i - 1) || !cons(i - 2)) return false;
    const ch = b[i];
    return ch !== "w" && ch !== "x" && ch !== "y";
  };

  /** b[0..k] ends with `s`; on success j marks the end of the stem before it. */
  const ends = (s: string): boolean => {
    const length = s.length;
    if (length > k + 1) return false;
    for (let i = 0; i < length; i += 1) {
      if (b[k - length + 1 + i] !== s[i]) return false;
    }
    j = k - length;
    return true;
  };

  /** Replace b[j+1..k] with `s`. */
  const setTo = (s: string): void => {
    b.length = j + 1;
    for (const ch of s) b.push(ch);
    k = j + s.length;
  };

  const replaceIfMeasured = (s: string): void => {
    if (m() > 0) setTo(s);
  };

  /** Tries each [suffix, replacement] pair in order; the first suffix that ends the word decides. */
  const firstRule = (rules: ReadonlyArray<readonly [string, string]>): void => {
    for (const [suffix, replacement] of rules) {
      if (ends(suffix)) {
        replaceIfMeasured(replacement);
        return;
      }
    }
  };

  // Step 1ab: plurals and -ed / -ing.
  if (b[k] === "s") {
    if (ends("sses")) k -= 2;
    else if (ends("ies")) setTo("i");
    else if (b[k - 1] !== "s") k -= 1;
  }
  if (ends("eed")) {
    if (m() > 0) k -= 1;
  } else if ((ends("ed") || ends("ing")) && vowelInStem()) {
    k = j;
    b.length = k + 1;
    if (ends("at")) setTo("ate");
    else if (ends("bl")) setTo("ble");
    else if (ends("iz")) setTo("ize");
    else if (doubleC(k)) {
      k -= 1;
      const ch = b[k];
      if (ch === "l" || ch === "s" || ch === "z") k += 1;
    } else if (m() === 1 && cvc(k)) {
      j = k;
      setTo("e");
    }
  }
  b.length = k + 1;

  // Step 1c: a terminal y becomes i when the stem has a vowel.
  if (ends("y") && vowelInStem()) b[k] = "i";

  // Step 2: double suffixes to single ones.
  switch (k >= 1 ? b[k - 1] : "") {
    case "a":
      firstRule([
        ["ational", "ate"],
        ["tional", "tion"],
      ]);
      break;
    case "c":
      firstRule([
        ["enci", "ence"],
        ["anci", "ance"],
      ]);
      break;
    case "e":
      firstRule([["izer", "ize"]]);
      break;
    case "l":
      firstRule([
        ["bli", "ble"],
        ["alli", "al"],
        ["entli", "ent"],
        ["eli", "e"],
        ["ousli", "ous"],
      ]);
      break;
    case "o":
      firstRule([
        ["ization", "ize"],
        ["ation", "ate"],
        ["ator", "ate"],
      ]);
      break;
    case "s":
      firstRule([
        ["alism", "al"],
        ["iveness", "ive"],
        ["fulness", "ful"],
        ["ousness", "ous"],
      ]);
      break;
    case "t":
      firstRule([
        ["aliti", "al"],
        ["iviti", "ive"],
        ["biliti", "ble"],
      ]);
      break;
    case "g":
      firstRule([["logi", "log"]]);
      break;
  }

  // Step 3: -ic-, -full, -ness and the like.
  switch (b[k]) {
    case "e":
      firstRule([
        ["icate", "ic"],
        ["ative", ""],
        ["alize", "al"],
      ]);
      break;
    case "i":
      firstRule([["iciti", "ic"]]);
      break;
    case "l":
      firstRule([
        ["ical", "ic"],
        ["ful", ""],
      ]);
      break;
    case "s":
      firstRule([["ness", ""]]);
      break;
  }

  // Step 4: drop -ant, -ence and the like when the measure is above 1.
  const step4Suffixes: Record<string, string[]> = {
    a: ["al"],
    c: ["ance", "ence"],
    e: ["er"],
    i: ["ic"],
    l: ["able", "ible"],
    n: ["ant", "ement", "ment", "ent"],
    s: ["ism"],
    t: ["ate", "iti"],
    u: ["ous"],
    v: ["ive"],
    z: ["ize"],
  };
  const penultimate = k >= 1 ? b[k - 1] : "";
  let step4Matched = false;
  if (penultimate === "o") {
    if (ends("ion") && j >= 0 && (b[j] === "s" || b[j] === "t")) {
      step4Matched = true;
    } else if (ends("ou")) {
      step4Matched = true;
    }
  } else {
    for (const suffix of step4Suffixes[penultimate] || []) {
      if (ends(suffix)) {
        step4Matched = true;
        break;
      }
    }
  }
  if (step4Matched && m() > 1) {
    k = j;
    b.length = k + 1;
  }

  // Step 5: a final -e, and -ll to -l, when the measure allows.
  j = k;
  if (b[k] === "e") {
    const measure = m();
    if (measure > 1 || (measure === 1 && !cvc(k - 1))) k -= 1;
  }
  b.length = k + 1;
  j = k;
  if (b[k] === "l" && doubleC(k) && m() > 1) k -= 1;
  b.length = k + 1;

  return b.join("");
}
