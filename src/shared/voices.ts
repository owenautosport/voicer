/*
 * What Kokoro can sound like, and how much of it to download.
 *
 * This sits in `shared/` because two places need exactly the same list and
 * disagreeing would be silent: the main process rejects a voice it does not
 * recognise and falls back to the default, so a voice offered in the settings
 * panel but missing here would appear to be selectable, appear to save, and
 * then never be used.
 */
/**
 * The voices worth offering, best first within each accent. Kokoro ships more
 * than this and grades them itself; the ones it grades D and F are not worth a
 * line in a settings panel.
 */
export const KOKORO_VOICES = [
  { id: 'bm_george', label: 'George — British' },
  { id: 'bm_fable', label: 'Fable — British' },
  { id: 'bm_daniel', label: 'Daniel — British' },
  { id: 'bm_lewis', label: 'Lewis — British' },
  { id: 'bf_emma', label: 'Emma — British' },
  { id: 'bf_isabella', label: 'Isabella — British' },
  { id: 'bf_alice', label: 'Alice — British' },
  { id: 'bf_lily', label: 'Lily — British' },
  { id: 'am_michael', label: 'Michael — American' },
  { id: 'am_puck', label: 'Puck — American' },
  { id: 'am_fenrir', label: 'Fenrir — American' },
  { id: 'af_heart', label: 'Heart — American' },
  { id: 'af_bella', label: 'Bella — American' },
  { id: 'af_nicole', label: 'Nicole — American' },
] as const

export const DEFAULT_KOKORO_VOICE = 'bm_george'

export const isKokoroVoice = (v: unknown): v is string =>
  typeof v === 'string' && KOKORO_VOICES.some((voice) => voice.id === v)

/**
 * Which weights to run — a download-size dial, and nothing like the tradeoff it
 * looks like.
 *
 * Measured on an Intel i5, full weights synthesise about twice as fast as they
 * are spoken, and the quantised ones about three times *slower* than that —
 * slower than real time, so the answer stalls between sentences. Quantising
 * this model buys a smaller download and costs speed, which is the opposite way
 * round from most of them.
 *
 * The 4-bit weights are not offered: they measure the same speed as full and
 * within five per cent of the same size, so they are strictly worse than full.
 */
export const KOKORO_DTYPES = [
  { id: 'fp32', label: 'Full — 320 MB' },
  { id: 'q8', label: 'Small — 96 MB, slower to speak' },
] as const

export type KokoroDtype = (typeof KOKORO_DTYPES)[number]['id']

export const DEFAULT_KOKORO_DTYPE: KokoroDtype = 'fp32'

export const isKokoroDtype = (v: unknown): v is KokoroDtype =>
  typeof v === 'string' && KOKORO_DTYPES.some((d) => d.id === v)
