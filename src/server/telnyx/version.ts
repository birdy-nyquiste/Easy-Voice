/**
 * Bump whenever what we send to Telnyx for an assistant changes (assistantBody() in the
 * live adapter, or toSpec() in agents), so existing agents are re-synced. It is part
 * of the agents' platform fingerprint.
 * v2: disable the assistant's own call recording (duplicate of ours).
 * v3: default dynamic_variables for {{call_direction}} / {{call_goal}}.
 * v4: English-only voices get an "always reply in English" instruction.
 */
export const ASSISTANT_BODY_VERSION = 4;
