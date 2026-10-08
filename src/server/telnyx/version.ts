/**
 * Bump whenever the live adapter's assistantBody() changes what it sends to Telnyx,
 * so existing agents are re-synced (it is part of the agents' platform fingerprint).
 * v2: disable the assistant's own call recording (duplicate of ours).
 * v3: default dynamic_variables for {{call_direction}} / {{call_goal}}.
 */
export const ASSISTANT_BODY_VERSION = 3;
