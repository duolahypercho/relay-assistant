import { hasNativeShares, mobileShares } from './native-mobile';
export const templateLinkBridge = () => {
  const desktop = (window as any).relayNative?.templates;
  if (desktop)
    return desktop as {
      peek(): Promise<{ item?: { id: string; url: string } }>;
      acknowledge(input: { id: string }): Promise<void>;
    };
  if (hasNativeShares())
    return {
      peek: () => mobileShares.peekTemplate(),
      acknowledge: (input: { id: string }) => mobileShares.acknowledgeTemplate(input),
    };
  return null;
};
export async function acknowledgeTemplateLink(id: string) {
  if (id) await templateLinkBridge()?.acknowledge({ id });
}
