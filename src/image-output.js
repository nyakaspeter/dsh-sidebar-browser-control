export async function admitScreenshot(ctx, exec, result) {
  if (typeof result?.data !== 'string') return result;
  const unavailable = (reason) => ({
    ok: false,
    code: 'SCREENSHOT_UNAVAILABLE',
    retryable: false,
    message: `Screenshot cannot be delivered: ${reason}. Continue with read/evaluate. Do not retry screenshots or restart DSH.`,
  });
  try {
    const attachments = ctx.get?.('attachments'),
      llm = ctx.get?.('llm');
    if (!attachments || !llm)
      return unavailable('image services are unavailable');
    const routed = exec.agent?.session?.requestHeader?.()?.config;
    const provider = routed?.provider ?? exec.agent?.options?.provider,
      model = routed?.model ?? exec.agent?.options?.model;
    if (!provider || !model)
      return unavailable('the current model route is unknown');
    const info = await llm.resolveModelInfo(provider, model, exec.signal);
    if (!info.inputModalities?.includes('image'))
      return unavailable(
        'the current model does not declare image input support',
      );
    exec.signal?.throwIfAborted();
    const data = Buffer.from(result.data, 'base64');
    if (!data.length || data.toString('base64') !== result.data)
      return unavailable('capture returned invalid image data');
    const [attachment] = await attachments.saveImages([
      {
        data,
        mediaType: 'image/png',
      },
    ]);
    if (!attachment?.attachmentId)
      return unavailable('image storage returned no attachment reference');
    const path = attachments.imageHostPath?.(attachment);
    return {
      attachment,
      ...(path ? { displayMarkdown: `![Browser screenshot](<${path}>)` } : {}),
    };
  } catch (error) {
    exec.signal?.throwIfAborted();
    return unavailable(error.message ?? 'image storage failed');
  }
}
export function renderBrowserOutput(args, value) {
  if (args.action !== 'screenshot') return [{ type: 'text', text: value }];
  const result = JSON.parse(value);
  return result?.attachment?.attachmentId
    ? [
        { type: 'image', attachment: result.attachment },
        ...(result.displayMarkdown
          ? [
              {
                type: 'text',
                text: `To show this screenshot to the user, include this exact Markdown in the final response: ${result.displayMarkdown}`,
              },
            ]
          : []),
      ]
    : [{ type: 'text', text: value }];
}
