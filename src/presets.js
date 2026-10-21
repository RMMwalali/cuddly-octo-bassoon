// Caption looks. Sizes are fractions of the video's shorter side so a preset
// looks the same on a 9:16 phone clip and a 16:9 YouTube video.

export const MOOD_COLORS = {
  neutral: null, // use the preset's accent
  excited: '#FFD23F',
  angry: '#FF4D4D',
  soft: '#9CCBFF',
  question: '#C9A8FF',
};

export const MOOD_LABELS = {
  neutral: 'Neutral',
  excited: 'Excited',
  angry: 'Intense',
  soft: 'Soft',
  question: 'Question',
};

export const PRESETS = {
  pop: {
    label: 'Pop',
    hint: 'Bold words, active word lights up',
    family: 'Montserrat',
    font: '"Montserrat", "Arial Black", "Helvetica Neue", sans-serif',
    weight: 900,
    size: 0.074,
    reveal: 'page',
    upper: true,
    fill: '#FFFFFF',
    accent: '#3DF28A',
    stroke: '#000000',
    strokeW: 0.17,
    shadow: true,
    box: false,
    scales: [1, 1.1, 1.28, 1.5],
    bump: 0.14,
  },
  hype: {
    label: 'Hype',
    hint: 'One word at a time, slams in',
    family: 'Anton',
    font: '"Anton", "Impact", "Arial Narrow Bold", sans-serif',
    weight: 400,
    size: 0.1,
    reveal: 'word',
    upper: true,
    fill: '#FFFFFF',
    accent: '#FFFFFF',
    stroke: '#000000',
    strokeW: 0.12,
    shadow: true,
    box: false,
    scales: [1, 1.12, 1.32, 1.65],
    bump: 0,
  },
  karaoke: {
    label: 'Karaoke',
    hint: 'Line fills in as it is spoken',
    family: 'Poppins',
    font: '"Poppins", "Segoe UI", sans-serif',
    weight: 800,
    size: 0.058,
    reveal: 'sweep',
    upper: false,
    fill: 'rgba(255,255,255,0.5)',
    accent: '#FFFFFF',
    stroke: '#000000',
    strokeW: 0.12,
    shadow: true,
    box: false,
    scales: [1, 1.06, 1.18, 1.36],
    bump: 0.06,
  },
  clean: {
    label: 'Clean',
    hint: 'Subtitle style for long-form',
    family: 'Inter',
    font: '"Inter", system-ui, sans-serif',
    weight: 600,
    size: 0.045,
    reveal: 'page',
    upper: false,
    fill: '#FFFFFF',
    accent: '#FFFFFF',
    stroke: '#000000',
    strokeW: 0,
    shadow: false,
    box: true,
    scales: [1, 1, 1.06, 1.16],
    bump: 0,
    emphasisWeight: 800,
  },
};

export const POSITIONS = { top: 0.2, middle: 0.62, bottom: 0.82 };

export const DEFAULT_SETTINGS = {
  preset: 'pop',
  position: 'middle',
  layout: 'short',
  sensitivity: 1,
  react: { size: true, color: true, motion: true, sounds: true },
};

/** Color an emphasized word should take on a page with this mood. */
export function emphasisColor(preset, mood, reactColor = true) {
  if (!reactColor) return preset.accent;
  return MOOD_COLORS[mood] || (preset.reveal === 'sweep' ? '#FFD23F' : preset.accent === '#FFFFFF' ? '#FFD23F' : preset.accent);
}
