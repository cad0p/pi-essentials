/**
 * Image Context Pruner
 *
 * Strips base64 image data from all but the most recent user message
 * before each LLM call. Images stay in the session file for history,
 * but don't eat context tokens on subsequent turns.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event, _ctx) => {
		const messages = event.messages;

		// Find the last user message index that has images
		let lastUserWithImageIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "user" && Array.isArray(msg.content)) {
				const hasImage = msg.content.some(
					(block: any) => block.type === "image" || block.type === "image_url"
				);
				if (hasImage) {
					lastUserWithImageIdx = i;
					break;
				}
			}
		}

		// Strip images from all user messages except the most recent one with images
		for (let i = 0; i < messages.length; i++) {
			if (i === lastUserWithImageIdx) continue;

			const msg = messages[i];
			if (msg.role === "user" && Array.isArray(msg.content)) {
				msg.content = msg.content.map((block: any) => {
					if (block.type === "image" || block.type === "image_url") {
						return { type: "text", text: "[image — already processed in earlier turn]" };
					}
					return block;
				});
			}
		}

		return { messages };
	});
}
