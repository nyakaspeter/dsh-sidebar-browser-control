// Combines per-frame read snapshots and applies compact/full pagination.
export function readLimits(args) {
  const full = args.detail === 'full';
  const textOffset = args.textOffset ?? 0,
    elementOffset = args.elementOffset ?? 0;
  if (
    !Number.isSafeInteger(textOffset) ||
    textOffset < 0 ||
    !Number.isSafeInteger(elementOffset) ||
    elementOffset < 0
  )
    throw new Error('Read offsets must be nonnegative integers.');
  return {
    textOffset,
    elementOffset,
    maxText: full ? 40000 : 6000,
    maxElements: full ? 200 : 40,
  };
}
// parts[0] is the main frame; later parts are cross-origin frames, whose refs
// were already prefixed with their frame key.
export function combineRead(parts, args, inaccessibleFrames = []) {
  const { textOffset, elementOffset, maxText, maxElements } = readLimits(args);
  const [main, ...frames] = parts;
  let text = main.text,
    textLength = main.textLength;
  for (const frame of frames) {
    // Main-content reads skip frame text; frame controls are still listed.
    if (!frame.text || main.scope === 'main') continue;
    const header = `\n\n[Frame ${frame.url}]\n`;
    text += header + frame.text;
    textLength += header.length + frame.textLength;
  }
  const elements = parts.flatMap((p) => p.elements);
  const total = parts.reduce((n, p) => n + p.total, 0);
  const moreText = textLength > textOffset + maxText,
    moreElements = total > elementOffset + maxElements;
  return {
    url: main.url,
    title: main.title,
    readyState: main.readyState,
    ...(main.scope && { scope: main.scope }),
    text: text.slice(textOffset, textOffset + maxText),
    elements: elements.slice(elementOffset, elementOffset + maxElements),
    totalElements: total,
    ...(moreText || moreElements
      ? {
          next: `${Math.min(textLength, textOffset + maxText)},${Math.min(total, elementOffset + maxElements)}`,
        }
      : {}),
    ...(frames.length
      ? { frames: frames.map((f) => ({ url: f.url, elements: f.total })) }
      : {}),
    ...(inaccessibleFrames.length ? { inaccessibleFrames } : {}),
  };
}
export function prefixRefs(part, key) {
  return {
    ...part,
    elements: part.elements.map((e) => ({ ...e, ref: `${key}:${e.ref}` })),
  };
}
