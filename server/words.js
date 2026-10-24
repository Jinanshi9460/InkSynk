// Word bank for the drawer's choices. Words are lowercase, ASCII, easy to draw, and may
// contain spaces ("ice cream") or hyphens. Categories are only used to keep the list tidy
// and (optionally) to spread choices across categories; they are never sent to clients.

export const WORD_BANK = {
  animals: [
    'cat', 'dog', 'horse', 'cow', 'pig', 'sheep', 'chicken', 'duck', 'rabbit', 'mouse',
    'elephant', 'giraffe', 'lion', 'tiger', 'bear', 'monkey', 'zebra', 'kangaroo', 'penguin', 'dolphin',
    'shark', 'whale', 'octopus', 'crab', 'turtle', 'frog', 'snake', 'spider', 'butterfly', 'bee',
    'owl', 'eagle', 'parrot', 'flamingo', 'camel', 'squirrel', 'hedgehog', 'snail', 'ladybug', 'jellyfish',
  ],
  food: [
    'apple', 'banana', 'pizza', 'burger', 'sandwich', 'cake', 'cookie', 'ice cream', 'popcorn', 'pancake',
    'carrot', 'tomato', 'potato', 'mushroom', 'pineapple', 'watermelon', 'strawberry', 'grapes', 'cheese', 'egg',
    'bread', 'donut', 'cupcake', 'lollipop', 'hot dog', 'sushi', 'taco', 'corn', 'lemon', 'cherry',
  ],
  objects: [
    'chair', 'table', 'bed', 'lamp', 'clock', 'key', 'door', 'window', 'umbrella', 'glasses',
    'book', 'pencil', 'scissors', 'backpack', 'camera', 'phone', 'laptop', 'television', 'headphones', 'guitar',
    'piano', 'drum', 'bell', 'candle', 'mirror', 'toothbrush', 'bucket', 'ladder', 'hammer', 'broom',
    'balloon', 'envelope', 'suitcase', 'wallet', 'flashlight', 'telescope', 'compass', 'anchor', 'crown', 'trophy',
  ],
  nature: [
    'sun', 'moon', 'star', 'cloud', 'rainbow', 'tree', 'flower', 'mountain', 'volcano', 'river',
    'waterfall', 'island', 'beach', 'desert', 'cactus', 'leaf', 'snowman', 'snowflake', 'lightning', 'tornado',
  ],
  places_and_vehicles: [
    'house', 'castle', 'bridge', 'lighthouse', 'tent', 'windmill', 'pyramid', 'school', 'hospital', 'farm',
    'car', 'bus', 'train', 'airplane', 'helicopter', 'rocket', 'bicycle', 'motorcycle', 'boat', 'submarine',
    'tractor', 'ambulance', 'sailboat', 'skateboard', 'hot air balloon',
  ],
  actions_and_people: [
    'swimming', 'running', 'sleeping', 'dancing', 'jumping', 'singing', 'fishing', 'painting', 'reading', 'cooking',
    'climbing', 'laughing', 'crying', 'sneezing', 'skiing', 'surfing', 'juggling', 'waving', 'pirate', 'astronaut',
    'robot', 'ghost', 'dragon', 'wizard', 'mermaid', 'cowboy', 'ninja', 'clown', 'king', 'detective',
  ],
};

// Flat, de-duplicated list (a word is never offered twice because it appears in two categories).
export const ALL_WORDS = [...new Set(Object.values(WORD_BANK).flat())];

/** Fisher-Yates using Math.random (word choice is not security-sensitive). */
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pick `count` UNIQUE words, preferring ones not in `used` (words already drawn this game).
 * If the unused pool is too small (very long games), already-used words fill the gap so the
 * drawer always gets exactly `count` distinct options.
 */
export function pickWordOptions(count, used = new Set()) {
  const fresh = shuffle(ALL_WORDS.filter((w) => !used.has(w)));
  const options = fresh.slice(0, count);
  if (options.length < count) {
    const reuse = shuffle(ALL_WORDS.filter((w) => !options.includes(w)));
    options.push(...reuse.slice(0, count - options.length));
  }
  return options;
}
