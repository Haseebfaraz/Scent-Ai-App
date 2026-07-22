// import { parse } from "csv-parse/sync";
// import fs from "fs";
// import path from "path";
// import crypto from "crypto";

// // 1. DATASET ENGINE LAYER
// let SCENT_CONTAINERS = [];
// try {
//   const csvPath = path.join(process.cwd(), "data", "Notes-Extraction-Separated.csv");
//   if (fs.existsSync(csvPath)) {
//     const fileContent = fs.readFileSync(csvPath, "utf-8");
//     SCENT_CONTAINERS = parse(fileContent, {
//       columns: true,
//       skip_empty_lines: true,
//       trim: true
//     });
//   }
// } catch (error) {
//   console.error("Dataset generation lookup failure:", error);
// }

// function queryScentContainers(userText) {
//   if (!userText || typeof userText !== "string") return SCENT_CONTAINERS.slice(0, 4);
//   const terms = userText.toLowerCase().split(/\s+/);
//   const matches = SCENT_CONTAINERS.filter(container => {
//     const titleText = String(container.Title || '').toLowerCase();
//     const notesText = String(container.Notes || '').toLowerCase();
//     return terms.some(term => term.length > 2 && (titleText.includes(term) || notesText.includes(term)));
//   });
//   return matches.length > 0 ? matches.slice(0, 6) : SCENT_CONTAINERS.slice(0, 4);
// }

// // 2. CONVERSATION MEMORY (in-memory store; resets on server restart — fine for dev)
// const CONVERSATIONS = new Map(); // conversationId -> [{ role, content }]

// function getConversation(conversationId) {
//   const id = conversationId && CONVERSATIONS.has(conversationId)
//     ? conversationId
//     : crypto.randomUUID();
//   if (!CONVERSATIONS.has(id)) CONVERSATIONS.set(id, []);
//   return { id, history: CONVERSATIONS.get(id) };
// }

// // 3. SYSTEM PROMPT — gives Claude the catalog of note containers and the exact conversation flow to follow
// function buildSystemPrompt() {
//   // Internal reference only — Title is never shown to Claude in a way it should repeat verbatim to the customer.
//   const catalogLines = SCENT_CONTAINERS.slice(0, 150).map(c =>
//     `- [internal_id: ${c.Title || "Untitled"}] Notes: ${c.Notes || "no notes listed"}`
//   ).join("\n");

//   return `You are Scent Architect AI, a fragrance consultant for a custom perfume store.
// You help customers build a personalized fragrance by combining note containers into layers (top, middle, base), purely by describing scent notes and character — never by internal product names.

// Internal catalog (for your reference only — see rules below on how to talk about these):
// ${catalogLines}

// CRITICAL RULE — never break this:
// - NEVER say, mention, or hint at the "internal_id" value (the container's Title/product name) in your conversational replies to the customer.
// - Only describe containers by their actual scent notes and character (e.g. "a blend of bergamot, cedar, and clove" or "a warm citrus-woody accord"). Speak like a perfumer describing a scent, not a catalog listing a SKU.
// - The internal_id exists only so you can reference the correct container internally when calling the confirm_scent_combination tool. It must never appear in your visible text response.

// CONVERSATION FLOW — follow these steps in order:

// 0. On the customer's first message, greet them warmly and briefly list what you can help with, similar to: "Hello! Welcome to our store. 😊 How can I help you today? I can assist with: Finding products you're looking for, Order status or tracking, Returns and exchanges, Shipping and store policies, or building you a custom fragrance blend! What can I do for you?"
//    - If the customer asks about order status, tracking, returns, exchanges, shipping, or store policies, politely let them know that capability isn't available yet in this chat, and suggest they contact the store directly for that — do not invent order details, policies, or tracking information.
//    - If the customer expresses interest in finding a product or building a custom fragrance, continue to step 1 below.

// 1. Start by asking: "How many containers of notes would you like to combine for your custom fragrance? You'll need at least 2 — most fragrances use 2 or 3 layers (top, middle, base)."
//    Wait for the customer to give a number (minimum 2). Remember this as their target count.

// 2. For each container, in order:
//    a. Ask a preference question to learn their taste for this layer, e.g.: "To get started, tell me a bit about what you love: do you lean more toward warm & cozy scents (vanilla, amber, tobacco), fresh & citrusy (bergamot, lemon, mandarin), floral (rose, jasmine), or deep & woody (oud, sandalwood, leather)?" (Adapt this question naturally for later containers, e.g. "For your next layer, what direction do you want to go?")
//    b. Based on their answer, suggest ONE specific note combination from the catalog above that matches their taste, described only by its notes (never the internal_id).
//    c. Ask which position this layer should be: "Would you like this to be your top note, middle note, or base note?" Only offer positions not already assigned to a previous layer in this conversation.
//    d. Once they confirm a position for this layer, move to the next container (repeat from 2a) until you've collected the number of containers they asked for in step 1.

// 3. If, after reaching their target count, the customer asks for even more layers, keep going — ask the same preference question, suggest notes, and ask for a position (if all 3 standard positions are taken, you can note this can be an additional accent to an existing layer).

// 4. Once all layers are chosen and positioned, summarize the full blend by describing top/middle/base in terms of notes only, and ask for final confirmation, e.g. "Shall I create this custom blend for you?"

// 5. Only once the customer confirms "yes" (or similar) to the full summary, call the confirm_scent_combination tool with all confirmed containers and their assigned positions. This is the only place internal_id should ever appear — never in your visible text.

// General guidelines:
// - Keep replies conversational, warm, and concise (2-4 sentences per turn).
// - Never invent notes or containers that aren't in the catalog above.
// - Don't skip steps or ask multiple questions at once — one step at a time, in order.`;
// }

// // 4. TOOL DEFINITION — structural signal for "customer confirmed a full combination with positions"
// const CONFIRM_COMBINATION_TOOL = {
//   name: "confirm_scent_combination",
//   description: "Call this once the customer has selected, positioned (top/middle/base), and given final confirmation for all note containers they want combined into a custom product.",
//   input_schema: {
//     type: "object",
//     properties: {
//       containers: {
//         type: "array",
//         minItems: 2,
//         items: {
//           type: "object",
//           properties: {
//             internal_id: {
//               type: "string",
//               description: "Exact internal_id (Title) of the note container."
//             },
//             position: {
//               type: "string",
//               enum: ["top", "middle", "base"],
//               description: "The fragrance layer this container was assigned to."
//             }
//           },
//           required: ["internal_id", "position"]
//         },
//         description: "All confirmed note containers with their assigned positions, minimum 2."
//       }
//     },
//     required: ["containers"]
//   }
// };

// // 5. CLAUDE API CALL (with tool-use resolution loop)
// async function callClaudeOnce(apiKey, messages, useTools) {
//   const response = await fetch("https://api.anthropic.com/v1/messages", {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "x-api-key": apiKey,
//       "anthropic-version": "2023-06-01"
//     },
//     body: JSON.stringify({
//       model: "claude-sonnet-5",
//       max_tokens: 500,
//       system: buildSystemPrompt(),
//       messages,
//       ...(useTools ? { tools: [CONFIRM_COMBINATION_TOOL] } : {})
//     })
//   });

//   if (!response.ok) {
//     const errText = await response.text();
//     console.error("Anthropic API error:", response.status, errText);
//     return null;
//   }

//   return response.json();
// }

// async function callClaude(history) {
//   const apiKey = process.env.CLAUDE_API_KEY;
//   if (!apiKey) {
//     return { replyText: "Configuration error: missing API key.", comboConfirmed: null };
//   }

//   let messages = [...history];
//   let comboConfirmed = null;
//   let finalText = "";

//   for (let turn = 0; turn < 3; turn++) {
//     const data = await callClaudeOnce(apiKey, messages, true);
//     if (!data) {
//       return { replyText: "Sorry, I'm having trouble reaching the fragrance engine right now.", comboConfirmed: null };
//     }

//     const textBlocks = data.content.filter(b => b.type === "text").map(b => b.text);
//     const toolUseBlock = data.content.find(b => b.type === "tool_use");

//     finalText = textBlocks.join(" ").trim();
//     messages.push({ role: "assistant", content: data.content });

//     if (data.stop_reason === "tool_use" && toolUseBlock) {
//       if (toolUseBlock.name === "confirm_scent_combination") {
//         comboConfirmed = toolUseBlock.input.containers || [];
//       }
//       messages.push({
//         role: "user",
//         content: [{
//           type: "tool_result",
//           tool_use_id: toolUseBlock.id,
//           content: "Combination noted internally. Do not call any more tools. Now respond directly to the customer in 2-3 warm sentences confirming their custom blend and what happens next."
//         }]
//       });
//       continue;
//     }

//     break;
//   }

//   if (!finalText) {
//     const nudge = [...messages, {
//       role: "user",
//       content: "Please reply to the customer now in 2-3 warm sentences. Do not call any tools."
//     }];
//     const data = await callClaudeOnce(apiKey, nudge, false);
//     if (data) {
//       const textBlocks = data.content.filter(b => b.type === "text").map(b => b.text);
//       finalText = textBlocks.join(" ").trim();
//       messages.push({ role: "user", content: "Please reply to the customer now in 2-3 warm sentences. Do not call any tools." });
//       messages.push({ role: "assistant", content: data.content });
//     }
//   }

//   return { replyText: finalText || "Great choice! Let's get that crafted for you.", comboConfirmed, updatedMessages: messages };
// }

// // 6. LOADER — handles history fetch (GET) requests from chat.js on page load
// export async function loader({ request }) {
//   const url = new URL(request.url);
//   const isHistoryRequest = url.searchParams.get("history") === "true";
//   const conversationId = url.searchParams.get("conversation_id");

//   if (isHistoryRequest) {
//     const history = conversationId && CONVERSATIONS.has(conversationId)
//       ? CONVERSATIONS.get(conversationId)
//       : [];

//     const messages = history
//       .filter(m => typeof m.content === "string" || Array.isArray(m.content))
//       .map(m => {
//         const textContent = Array.isArray(m.content)
//           ? m.content.filter(b => b.type === "text").map(b => b.text).join(" ")
//           : m.content;
//         return { role: m.role, content: textContent };
//       })
//       .filter(m => m.content && m.content.trim() !== "");

//     return new Response(JSON.stringify({ messages }), {
//       status: 200,
//       headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
//     });
//   }

//   // Fallback: not used by chat.js for normal messaging anymore (POST is used instead)
//   return new Response(JSON.stringify({ messages: [] }), {
//     status: 200,
//     headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
//   });
// }

// // 7. ACTION — handles incoming chat messages (POST) with real Claude conversation
// export async function action({ request }) {
//   const corsHeaders = {
//     "Access-Control-Allow-Origin": "*",
//     "Access-Control-Allow-Headers": "Content-Type, Authorization",
//     "Access-Control-Allow-Methods": "POST, OPTIONS"
//   };

//   if (request.method === "OPTIONS") {
//     return new Response(null, { status: 204, headers: corsHeaders });
//   }

//   try {
//     const body = await request.json();
//     const userMessage = body.message || "";
//     const { id: conversationId, history } = getConversation(body.conversation_id);

//     history.push({ role: "user", content: userMessage });

//     const { replyText, comboConfirmed, updatedMessages } = await callClaude(history);

//     // Persist the resolved conversation (includes tool_use/tool_result turns)
//     CONVERSATIONS.set(conversationId, updatedMessages || history);

//     const stream = new ReadableStream({
//       start(controller) {
//         const encoder = new TextEncoder();
//         const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

//         send({ type: "id", conversation_id: conversationId });

//         // comboConfirmed (internal container Titles) is available here for phase 3 (product creation)
//         // but intentionally NOT sent to the frontend — customer should never see internal names.
//         if (comboConfirmed && comboConfirmed.length >= 2) {
//           console.log("Combo confirmed:", comboConfirmed);
//         }

//         send({ type: "chunk", chunk: replyText });
//         send({ type: "message_complete" });
//         send({ type: "end_turn" });

//         controller.close();
//       },
//     });

//     return new Response(stream, {
//       status: 200,
//       headers: {
//         ...corsHeaders,
//         "Content-Type": "text/event-stream",
//         "Cache-Control": "no-cache",
//         "Connection": "keep-alive",
//       },
//     });

//   } catch (err) {
//     console.error("Action error:", err);
//     const stream = new ReadableStream({
//       start(controller) {
//         const encoder = new TextEncoder();
//         controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "Error processing request." })}\n\n`));
//         controller.close();
//       },
//     });
//     return new Response(stream, {
//       status: 200,
//       headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
//     });
//   }
// }





// import { json } from "@remix-run/node"; 
// import { parse } from "csv-parse/sync";
// import fs from "fs";
// import path from "path";
// import crypto from "crypto";
// import { unauthenticated } from "../shopify.server"; // Safe backend authentication helper

// // ============================================================
// // 1. DATASET ENGINE LAYER
// // ============================================================
// let SCENT_CONTAINERS = [];
// try {
//   const csvPath = path.join(process.cwd(), "data", "Notes-Extraction-Separated.csv");
//   if (fs.existsSync(csvPath)) {
//     const fileContent = fs.readFileSync(csvPath, "utf-8");
//     SCENT_CONTAINERS = parse(fileContent, {
//       columns: true,
//       skip_empty_lines: true,
//       trim: true
//     });
//     console.log(`[Dataset Engine] Successfully indexed ${SCENT_CONTAINERS.length} fragrance profiles.`);
//   } else {
//     console.warn(`[Dataset Engine] CSV file not found at: ${csvPath}`);
//   }
// } catch (error) {
//   console.error("Dataset generation lookup failure:", error);
// }

// function queryScentContainers(userText) {
//   if (!userText || typeof userText !== "string") return SCENT_CONTAINERS.slice(0, 4);
//   const terms = userText.toLowerCase().split(/\s+/);
//   const matches = SCENT_CONTAINERS.filter(container => {
//     const titleText = String(container.Title || '').toLowerCase();
//     const notesText = String(container.Notes || '').toLowerCase();
//     return terms.some(term => term.length > 2 && (titleText.includes(term) || notesText.includes(term)));
//   });
//   return matches.length > 0 ? matches.slice(0, 6) : SCENT_CONTAINERS.slice(0, 4);
// }

// // Pricing rules for your database catalog
// const PLACEHOLDER_PRICE_PER_ML = 5.0;
// const PLACEHOLDER_STOCK_ML = 1000;

// function getContainerPricing(internal_id) {
//   const container = findContainerByInternalId(internal_id);
//   if (!container) return null;

//   return {
//     internal_id,
//     pricePerMl: container.PricePerMl ? parseFloat(container.PricePerMl) : PLACEHOLDER_PRICE_PER_ML,
//     availableMl: container.Stock ? parseFloat(container.Stock) : PLACEHOLDER_STOCK_ML,
//     isPlaceholder: !container.PricePerMl,
//   };
// }

// function normalizeForMatch(str) {
//   return String(str)
//     .normalize("NFC")
//     .trim()
//     .toLowerCase();
// }

// function findContainerByInternalId(internal_id) {
//   if (!internal_id) return null;
//   const target = normalizeForMatch(internal_id);
//   return SCENT_CONTAINERS.find(c => normalizeForMatch(c.Title) === target) || null;
// }

// // ============================================================
// // 2. CONVERSATION MEMORY
// // ============================================================
// const CONVERSATIONS = new Map(); 

// function getConversation(conversationId) {
//   const id = conversationId && CONVERSATIONS.has(conversationId)
//     ? conversationId
//     : crypto.randomUUID();
//   if (!CONVERSATIONS.has(id)) CONVERSATIONS.set(id, []);
//   return { id, history: CONVERSATIONS.get(id) };
// }

// // ============================================================
// // 3. SYSTEM PROMPT
// // ============================================================
// function buildSystemPrompt() {
//   const catalogLines = SCENT_CONTAINERS.slice(0, 150).map(c =>
//     `- [internal_id: ${c.Title || "Untitled"}] Notes: ${c.Notes || "no notes listed"}`
//   ).join("\n");

//   return `You are Scent Architect AI, a fragrance consultant for a custom perfume store.
// You help customers build a personalized fragrance by combining note containers into layers (top, middle, base), purely by describing scent notes and character — never by internal product names.

// Internal catalog (for your reference only — see rules below on how to talk about these):
// ${catalogLines}

// CRITICAL RULE — never break this:
// - NEVER say, mention, or hint at the "internal_id" value (the container's Title/product name) in your conversational replies to the customer.
// - Only describe containers by their actual scent notes and character (e.g. "a blend of bergamot, cedar, and clove" or "a warm citrus-woody accord"). Speak like a perfumer describing a scent, not a catalog listing a SKU.
// - The internal_id exists only so you can reference the correct container internally when calling the confirm_scent_combination tool. It must never appear in your visible text response.

// CONVERSATION FLOW — follow these steps in order:

// 0. On the customer's first message, greet them warmly and briefly list what you can help with, similar to: "Hello! Welcome to our store. 😊 How can I help you today? I can assist with: Finding products you're looking for, Order status or tracking, Returns and exchanges, Shipping and store policies, or building you a custom fragrance blend! What can I do for you?"
//    - If the customer asks about order status, tracking, returns, exchanges, shipping, or store policies, politely let them know that capability isn't available yet in this chat, and suggest they contact the store directly for that — do not invent order details, policies, or tracking information.
//    - If the customer expresses interest in finding a product or building a custom fragrance, continue to step 1 below.

// 1. Start by asking: "How many containers of notes would you like to combine for your custom fragrance? You'll need at least 2 — most fragrances use 2 or 3 layers (top, middle, base)."
//    Wait for the customer to give a number (minimum 2). Remember this as their target count.

// 2. For each container, in order:
//    a. Ask a preference question to learn their taste for this layer, e.g.: "To get started, tell me a bit about what you love: do you lean more toward warm & cozy scents (vanilla, amber, tobacco), fresh & citrusy (bergamot, lemon, mandarin), floral (rose, jasmine), or deep & woody (oud, sandalwood, leather)?" (Adapt this question naturally for later containers, e.g. "For your next layer, what direction do you want to go?")
//    b. Based on their answer, suggest ONE specific note combination from the catalog above that matches their taste, described only by its notes (never the internal_id).
//    c. Ask which position this layer should be: "Would you like this to be your top note, middle note, or base note?" Only offer positions not already assigned to a previous layer in this conversation.
//    d. Once they confirm a position for this layer, move to the next container (repeat from 2a) until you've collected the number of containers they asked for in step 1.

// 3. If, after reaching their target count, the customer asks for even more layers, keep going — ask the same preference question, suggest notes, and ask for a position (if all 3 standard positions are taken, you can note this can be an additional accent to an existing layer).

// 4. Once all layers are chosen and positioned, summarize the full blend by describing top/middle/base in terms of notes only, and ask for final confirmation, e.g. "Shall I create this custom blend for you?" Also ask if they have a name in mind for their fragrance, or if you should create one for them.

// 5. Only once the customer confirms "yes" (or similar) to the full summary, call the confirm_scent_combination tool with all confirmed containers and their assigned positions, plus a customName and short description. This is the only place internal_id should ever appear — never in your visible text.

// General guidelines:
// - Keep replies conversational, warm, and concise (2-4 sentences per turn).
// - Never invent notes or containers that aren't in the catalog above.
// - Don't skip steps or ask multiple questions at once — one step at a time, in order.`;
// }

// // ============================================================
// // 4. TOOL DEFINITION
// // ============================================================
// const CONFIRM_COMBINATION_TOOL = {
//   name: "confirm_scent_combination",
//   description: "Call this once the customer has selected, positioned (top/middle/base), and given final confirmation for all note containers they want combined into a custom product.",
//   input_schema: {
//     type: "object",
//     properties: {
//       containers: {
//         type: "array",
//         minItems: 2,
//         items: {
//           type: "object",
//           properties: {
//             internal_id: { type: "string", description: "Exact internal_id (Title) of the note container." },
//             position: { type: "string", enum: ["top", "middle", "base"], description: "The fragrance layer this container was assigned to." },
//             quantityMl: { type: "number", default: 30, description: "How many ml of this container the customer wants." }
//           },
//           required: ["internal_id", "position"]
//         },
//         description: "All confirmed note containers with their assigned positions, minimum 2."
//       },
//       customName: { type: "string", description: "A unique, creative, personalized name for this fragrance." },
//       description: { type: "string", description: "A short, appealing 1-2 sentence product description." }
//     },
//     required: ["containers", "customName", "description"]
//   }
// };

// // ============================================================
// // 5. CLAUDE API CALL (with tool-use resolution loop)
// // ============================================================
// async function callClaudeOnce(apiKey, messages, useTools) {
//   const response = await fetch("https://api.anthropic.com/v1/messages", {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "x-api-key": apiKey,
//       "anthropic-version": "2023-06-01"
//     },
//     body: JSON.stringify({
//       model: "claude-sonnet-5", // KEPT EXACTLY THE SAME TO PREVENT BOT BREAKAGE
//       max_tokens: 500,
//       system: buildSystemPrompt(),
//       messages,
//       ...(useTools ? { tools: [CONFIRM_COMBINATION_TOOL] } : {})
//     })
//   });

//   if (!response.ok) {
//     const errText = await response.text();
//     console.error("Anthropic API error:", response.status, errText);
//     return null;
//   }

//   return response.json();
// }

// async function callClaude(history) {
//   const apiKey = process.env.CLAUDE_API_KEY;
//   if (!apiKey) {
//     return { replyText: "Configuration error: missing API key.", comboConfirmed: null };
//   }

//   let messages = [...history];
//   let comboConfirmed = null;
//   let confirmedName = null;
//   let confirmedDescription = null;
//   let finalText = "";

//   for (let turn = 0; turn < 3; turn++) {
//     const data = await callClaudeOnce(apiKey, messages, true);
//     if (!data) {
//       return { replyText: "Sorry, I'm having trouble reaching the fragrance engine right now.", comboConfirmed: null };
//     }

//     const textBlocks = data.content.filter(b => b.type === "text").map(b => b.text);
//     const toolUseBlock = data.content.find(b => b.type === "tool_use");

//     finalText = textBlocks.join(" ").trim();
//     messages.push({ role: "assistant", content: data.content });

//     if (data.stop_reason === "tool_use" && toolUseBlock) {
//       if (toolUseBlock.name === "confirm_scent_combination") {
//         comboConfirmed = toolUseBlock.input.containers || [];
//         confirmedName = toolUseBlock.input.customName || "Custom Blend";
//         confirmedDescription = toolUseBlock.input.description || "";
//       }
//       messages.push({
//         role: "user",
//         content: [{
//           type: "tool_result",
//           tool_use_id: toolUseBlock.id,
//           content: "Combination noted internally. Do not call any more tools. Now respond directly to the customer in 2-3 warm sentences confirming their custom blend has been created and is ready."
//         }]
//       });
//       continue;
//     }

//     break;
//   }

//   if (!finalText) {
//     const nudge = [...messages, {
//       role: "user",
//       content: "Please reply to the customer now in 2-3 warm sentences. Do not call any tools."
//     }];
//     const data = await callClaudeOnce(apiKey, nudge, false);
//     if (data) {
//       const textBlocks = data.content.filter(b => b.type === "text").map(b => b.text);
//       finalText = textBlocks.join(" ").trim();
//       messages.push({ role: "user", content: "Please reply to the customer now in 2-3 warm sentences. Do not call any tools." });
//       messages.push({ role: "assistant", content: data.content });
//     }
//   }

//   return {
//     replyText: finalText || "Great choice! Let's get that crafted for you.",
//     comboConfirmed,
//     confirmedName,
//     confirmedDescription,
//     updatedMessages: messages
//   };
// }

// // ============================================================
// // 6. DYNAMIC PRODUCT CREATION
// // ============================================================
// async function createDynamicProduct(admin, shopDomain, comboConfirmed, customName, description) {
//   const FIXED_PRICE = "60.00";
//   const FIXED_STOCK = 1;

//   // Verify all containers exist before creating anything
//   const layerDetails = comboConfirmed.map(item => {
//     const container = findContainerByInternalId(item.internal_id);
//     if (!container) throw new Error(`Container "${item.internal_id}" not found.`);
//     return {
//       title: item.internal_id,
//       notes: container.Notes || "",
//       position: item.position,
//       quantityMl: item.quantityMl || 30
//     };
//   });

//   const createResponse = await admin.graphql(`
//     mutation createProduct($input: ProductInput!) {
//       productCreate(input: $input) {
//         product { id handle }
//         userErrors { field message }
//       }
//     }
//   `, {
//     variables: {
//       input: {
//         title: customName,
//         descriptionHtml: description,
//         templateSuffix: "custom-scent",
//         status: "ACTIVE",
//         metafields: [
//           {
//             namespace: "custom",
//             key: "note_composition",
//             type: "json",
//             value: JSON.stringify(layerDetails)
//           }
//         ]
//       }
//     }
//   });

//   const createJson = await createResponse.json();
//   const product = createJson.data?.productCreate?.product;
//   const createErrors = createJson.data?.productCreate?.userErrors;

//   if (!product || (createErrors && createErrors.length > 0)) {
//     throw new Error(createErrors?.map(e => e.message).join(", ") || "Product creation failed.");
//   }

//   // Get the default variant + its inventory item
//   const variantsResponse = await admin.graphql(`
//     query getVariants($id: ID!) {
//       product(id: $id) {
//         variants(first: 1) {
//           edges { node { id inventoryItem { id } } }
//         }
//       }
//     }
//   `, { variables: { id: product.id } });
//   const variantsJson = await variantsResponse.json();
//   const variantEdge = variantsJson.data?.product?.variants?.edges?.[0];
//   const defaultVariantId = variantEdge?.node?.id;
//   const inventoryItemId = variantEdge?.node?.inventoryItem?.id;

//   // Set the fixed price
//   if (defaultVariantId) {
//     await admin.graphql(`
//       mutation setPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
//         productVariantsBulkUpdate(productId: $productId, variants: $variants) {
//           product { id }
//           userErrors { field message }
//         }
//       }
//     `, {
//       variables: {
//         productId: product.id,
//         variants: [{ id: defaultVariantId, price: FIXED_PRICE }],
//       },
//     });
//   }

//   // Set stock to 1 at the store's primary location
//   if (inventoryItemId) {
//     try {
//       const locationsResponse = await admin.graphql(`
//         query getPrimaryLocation {
//           locations(first: 1) {
//             edges { node { id } }
//           }
//         }
//       `);
//       const locationsJson = await locationsResponse.json();
//       const locationId = locationsJson.data?.locations?.edges?.[0]?.node?.id;

//       if (locationId) {
//         await admin.graphql(`
//           mutation setInventory($input: InventorySetQuantitiesInput!) {
//             inventorySetQuantities(input: $input) {
//               userErrors { field message }
//             }
//           }
//         `, {
//           variables: {
//             input: {
//               name: "available",
//               reason: "correction",
//               ignoreCompareQuantity: true,
//               quantities: [{ inventoryItemId, locationId, quantity: FIXED_STOCK }]
//             }
//           }
//         });
//       }
//     } catch (invErr) {
//       console.error("Failed to set inventory quantity:", invErr);
//       // Don't fail the whole product just because stock-setting failed
//     }
//   }

//   const cleanShopDomain = shopDomain.replace(/^https?:\/\//, '');
//   const productUrl = `https://${cleanShopDomain}/products/${product.handle}`;

//   return { productUrl, totalPrice: parseFloat(FIXED_PRICE), usedPlaceholderPricing: false };
// }

// // ============================================================
// // 7. LOADER — handles history fetch (GET) requests
// // ============================================================
// export async function loader({ request }) {
//   const url = new URL(request.url);
//   const isHistoryRequest = url.searchParams.get("history") === "true";
//   const conversationId = url.searchParams.get("conversation_id");

//   if (isHistoryRequest) {
//     const history = conversationId && CONVERSATIONS.has(conversationId)
//       ? CONVERSATIONS.get(conversationId)
//       : [];

//     const messages = history
//       .filter(m => typeof m.content === "string" || Array.isArray(m.content))
//       .map(m => {
//         const textContent = Array.isArray(m.content)
//           ? m.content.filter(b => b.type === "text").map(b => b.text).join(" ")
//           : m.content;
//         return { role: m.role, content: textContent };
//       })
//       .filter(m => m.content && m.content.trim() !== "");

//     return new Response(JSON.stringify({ messages }), {
//       status: 200,
//       headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
//     });
//   }

//   return new Response(JSON.stringify({ messages: [] }), {
//     status: 200,
//     headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
//   });
// }

// // ============================================================
// // 8. ACTION — handles incoming chat messages (POST)
// // ============================================================
// export async function action({ request }) {
//   const corsHeaders = {
//     "Access-Control-Allow-Origin": "*",
//     "Access-Control-Allow-Headers": "Content-Type, Authorization",
//     "Access-Control-Allow-Methods": "POST, OPTIONS"
//   };

//   if (request.method === "OPTIONS") {
//     return new Response(null, { status: 204, headers: corsHeaders });
//   }

//   try {
//     const originHeader = request.headers.get("Origin") || "";
//     let shopDomain = originHeader.replace(/^https?:\/\//, '').split('/')[0];
    
//     if (!shopDomain) {
//       shopDomain = "test-3d-products.myshopify.com"; 
//     }

//     // Connect to Shopify's Admin backend context securely
//     let admin = null;
//     try {
//       if (shopDomain) {
//         const result = await unauthenticated.admin(shopDomain);
//         admin = result.admin;
//         console.log("Successfully verified session credentials for:", shopDomain);
//       }
//     } catch (authErr) {
//       console.error("Admin verification session lookup failure:", authErr.message);
//     }

//     const body = await request.json();
//     const userMessage = body.message || "";
//     const { id: conversationId, history } = getConversation(body.conversation_id);

//     history.push({ role: "user", content: userMessage });

//     const { replyText, comboConfirmed, confirmedName, confirmedDescription, updatedMessages } = await callClaude(history);

//     CONVERSATIONS.set(conversationId, updatedMessages || history);

//     let productResult = null;
//     let productError = null;

//     if (comboConfirmed && comboConfirmed.length >= 2) {
//       if (!admin) {
//         productError = "Product creation is unavailable right now (session handshake failed).";
//         console.error(productError);
//       } else {
//         try {
//           productResult = await createDynamicProduct(admin, shopDomain, comboConfirmed, confirmedName, confirmedDescription);
//           console.log("Dynamic product created successfully:", productResult.productUrl);
//         } catch (err) {
//           productError = err.message;
//           console.error("Dynamic product creation failed:", err);
//         }
//       }
//     }

//     const stream = new ReadableStream({
//       start(controller) {
//         const encoder = new TextEncoder();
//         const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

//         send({ type: "id", conversation_id: conversationId });
//         send({ type: "chunk", chunk: replyText });

//         if (productResult) {
//           send({ type: "product_created", url: productResult.productUrl, price: productResult.totalPrice });
//         }
//         if (productError) {
//           send({ type: "product_error", error: productError });
//         }

//         send({ type: "message_complete" });
//         send({ type: "end_turn" });
//         controller.close();
//       },
//     });

//     return new Response(stream, {
//       status: 200,
//       headers: {
//         ...corsHeaders,
//         "Content-Type": "text/event-stream",
//         "Cache-Control": "no-cache",
//         "Connection": "keep-alive",
//       },
//     });

//   } catch (err) {
//     console.error("Action error:", err);
//     const stream = new ReadableStream({
//       start(controller) {
//         const encoder = new TextEncoder();
//         controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "Error processing request." })}\n\n`));
//         controller.close();
//       },
//     });
//     return new Response(stream, {
//       status: 200,
//       headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
//     });
//   }
// }











import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";

// ============================================================
// 1. DATASET ENGINE LAYER
// ============================================================
let SCENT_CONTAINERS = [];
try {
  const csvPath = path.join(process.cwd(), "data", "Notes-Extraction-Separated.csv");
  if (fs.existsSync(csvPath)) {
    const fileContent = fs.readFileSync(csvPath, "utf-8");
    SCENT_CONTAINERS = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    console.log(`[Dataset Engine] Successfully indexed ${SCENT_CONTAINERS.length} fragrance profiles.`);
  } else {
    console.warn(`[Dataset Engine] CSV file not found at: ${csvPath}`);
  }
} catch (error) {
  console.error("Dataset generation lookup failure:", error);
}

function normalizeForMatch(str) {
  return String(str).normalize("NFC").trim().toLowerCase();
}

function findContainerByInternalId(internal_id) {
  if (!internal_id) return null;
  const target = normalizeForMatch(internal_id);
  return SCENT_CONTAINERS.find(c => normalizeForMatch(c.Title) === target) || null;
}

// The full catalog is ~3.5k rows — showing a fixed slice of the first 150 (file order) meant the
// model often had no good match for whatever the customer actually asked for, and would invent a
// title instead of picking a real one. Score by keyword overlap with the conversation so far and
// show the most relevant rows, padding with the rest if there aren't enough relevant matches.
function scoreContainersFor(text) {
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  if (words.length === 0) return [];
  return SCENT_CONTAINERS
    .map(c => {
      // Notes-only — the Title is never shown to the customer and its wording is often
      // unrelated to what's actually in the container (e.g. "Marshmallow Vanilla" whose real
      // Notes are "Cocoa, Tahitian Vanilla, and Blood Orange", no marshmallow note at all).
      // Matching the title let a customer asking for "marshmallow" get served that container on
      // name alone, tied in score with (or ranked above) containers that genuinely list
      // Marshmallow as a real note.
      const haystack = (c.Notes || "").toLowerCase();
      const score = words.reduce((s, w) => (haystack.includes(w) ? s + 1 : s), 0);
      return { c, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.c);
}

// Each user message describes its own layer/preference — score independently PER MESSAGE and
// merge each one's own top matches, instead of one score blended across the whole conversation.
// A blended score lets a single "jack of all trades" container that partially matches several
// layers outrank the single best match for any one specific layer, so by the final confirmation
// turn (with 3-4 layers already discussed) an earlier layer's ideal container could fall out of
// the slice entirely — the model then has no real match to copy internal_id from and invents one.
// Scoring per-message guarantees every stated preference stays represented regardless of how many
// turns have passed since it was mentioned; iterating most-recent-first keeps recency as a
// tiebreaker without letting it crowd anything out.
function buildRelevantCatalogSlice(history, limit = 250) {
  const userMessages = (history || []).filter(m => m.role === "user" && typeof m.content === "string");
  if (userMessages.length === 0) return SCENT_CONTAINERS.slice(0, limit);

  const PER_MESSAGE_TOP = 40;
  const seen = new Set();
  const merged = [];
  for (const msg of [...userMessages].reverse()) {
    for (const c of scoreContainersFor(msg.content).slice(0, PER_MESSAGE_TOP)) {
      if (!seen.has(c.Title)) { merged.push(c); seen.add(c.Title); }
    }
    if (merged.length >= limit) break;
  }

  if (merged.length >= limit) return merged.slice(0, limit);

  const padded = [...merged];
  for (const c of SCENT_CONTAINERS) {
    if (padded.length >= limit) break;
    if (!seen.has(c.Title)) { padded.push(c); seen.add(c.Title); }
  }
  return padded;
}

// ============================================================
// REGION-BASED NOTE POPULARITY (from real order history, city -> state -> country fallback)
// ============================================================

// Same normalization used for both the cached map keys and the candidate text extracted from
// conversation — matters because names have inconsistent punctuation in the source data (e.g.
// "St. Clair Shores" vs "St Clair Shores"); normalizing both sides identically means a customer
// typing it either way still matches.
function normalizeRegionText(str) {
  return str.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

// Distinct city/state/country names are cached after the first lookup — the underlying data
// doesn't change at runtime, and re-scanning ~937k rows for every message would be wasteful.
// Keyed by normalized text for matching, valued by the real casing stored in the DB — SQLite
// comparisons are case-sensitive by default (no "insensitive" query mode like Postgres has), so
// we look up the correctly-cased value here rather than trying to query case-insensitively later.
let cachedRegionMaps = null;
async function getRegionMaps() {
  if (cachedRegionMaps) return cachedRegionMaps;
  cachedRegionMaps = { city: new Map(), stateName: new Map(), countryName: new Map() };
  try {
    for (const field of ["city", "stateName", "countryName"]) {
      const rows = await prisma.orderHistory.findMany({
        distinct: [field],
        select: { [field]: true },
        where: { [field]: { not: null } }
      });
      for (const row of rows) {
        if (row[field]) cachedRegionMaps[field].set(normalizeRegionText(row[field]), row[field]);
      }
    }
  } catch (err) {
    console.error("Failed to load region lists:", err.message);
  }
  return cachedRegionMaps;
}

// Scans the customer's own messages for a known city, state, OR country name (whichever is
// most specific) — checking 1-4 word windows so multi-word names like "New York" or "United
// Arab Emirates" are caught. Not full NLP, just a lookup against real region names that exist
// in the order history data. A customer naming their country directly (e.g. "Spain") is just as
// valid a signal as naming a city — city is only preferred when both happen to be mentioned.
function extractRegionFromHistory(history, regionMaps) {
  const levels = [
    { field: "city", map: regionMaps.city },
    { field: "stateName", map: regionMaps.stateName },
    { field: "countryName", map: regionMaps.countryName }
  ];
  for (const msg of history) {
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const words = normalizeRegionText(msg.content).split(" ").filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (let len = 4; len >= 1; len--) {
        const candidate = words.slice(i, i + len).join(" ");
        for (const { field, map } of levels) {
          if (map.has(candidate)) return { field, value: map.get(candidate) };
        }
      }
    }
  }
  return null;
}

function tallyNotes(orders, limit) {
  const tally = {};
  for (const order of orders) {
    const notes = order.notes.split(",").map(n => n.trim()).filter(Boolean);
    for (const note of notes) {
      tally[note] = (tally[note] || 0) + 1;
    }
  }
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

// Cascades from whichever level was actually matched down to broader ones (city -> its state ->
// its country, or state -> its country, or country alone) if the more specific sample is too
// small to be meaningful — matches how real fragrance popularity actually varies by region.
const MIN_SAMPLE_SIZE = 20;
async function getPopularNotesForRegion(region, limit = 8) {
  if (!region) return [];
  const { field, value } = region;

  try {
    let attempts;
    if (field === "city") {
      const cityMatch = await prisma.orderHistory.findFirst({
        where: { city: value },
        select: { stateName: true, countryName: true }
      });
      attempts = [
        { city: value },
        cityMatch?.stateName && { stateName: cityMatch.stateName },
        cityMatch?.countryName && { countryName: cityMatch.countryName }
      ];
    } else if (field === "stateName") {
      const stateMatch = await prisma.orderHistory.findFirst({
        where: { stateName: value },
        select: { countryName: true }
      });
      attempts = [
        { stateName: value },
        stateMatch?.countryName && { countryName: stateMatch.countryName }
      ];
    } else {
      attempts = [{ countryName: value }];
    }

    for (const where of attempts.filter(Boolean)) {
      const orders = await prisma.orderHistory.findMany({
        where,
        select: { notes: true },
        take: 3000 // cap the scan for performance on a ~937k row table
      });
      if (orders.length >= MIN_SAMPLE_SIZE) {
        return tallyNotes(orders, limit);
      }
    }
  } catch (err) {
    console.error("Failed to look up regional notes:", err.message);
  }
  return [];
}

const PLACEHOLDER_PRICE_PER_ML = 5.0;
const PLACEHOLDER_STOCK_ML = 1000;

function getContainerPricing(internal_id) {
  const container = findContainerByInternalId(internal_id);
  if (!container) return null;

  return {
    internal_id,
    pricePerMl: container.PricePerMl ? parseFloat(container.PricePerMl) : PLACEHOLDER_PRICE_PER_ML,
    availableMl: container.Stock ? parseFloat(container.Stock) : PLACEHOLDER_STOCK_ML,
    isPlaceholder: !container.PricePerMl,
  };
}

// ============================================================
// 2. CONVERSATION MEMORY
// ============================================================
const CONVERSATIONS = new Map();

function getConversation(conversationId) {
  const id = conversationId && CONVERSATIONS.has(conversationId)
    ? conversationId
    : crypto.randomUUID();
  if (!CONVERSATIONS.has(id)) CONVERSATIONS.set(id, []);
  return { id, history: CONVERSATIONS.get(id) };
}

// Tracks every internal_id that search_containers_for_layer has actually returned for a given
// conversation — the confirm_scent_combination gate chain checks against this set (not just "does
// this title exist anywhere in the catalog") so a container can only ever be finalized if it was
// genuinely surfaced by a real search, never one the model picked from memory without checking.
const OFFERED_CONTAINERS = new Map();
function getOfferedSet(conversationId) {
  if (!OFFERED_CONTAINERS.has(conversationId)) OFFERED_CONTAINERS.set(conversationId, new Set());
  return OFFERED_CONTAINERS.get(conversationId);
}

// ============================================================
// 3. SYSTEM PROMPT
// ============================================================
async function buildSystemPrompt(history) {
  const catalogLines = buildRelevantCatalogSlice(history).map(c =>
    `- [internal_id: ${c.Title || "Untitled"}] Notes: ${c.Notes || "no notes listed"}`
  ).join("\n");

  const regionMaps = await getRegionMaps();
  const regionCandidate = extractRegionFromHistory(history, regionMaps);
  const regionalNotes = await getPopularNotesForRegion(regionCandidate);
  const regionalNotesLine = regionalNotes.length > 0
    ? `\nReal past customers from this same region have shown a taste for these notes: ${regionalNotes.join(", ")}. Use this for step 3 below — share it as a plain, positive statement about the region itself once you learn where they live (e.g. "Fragrances with warm, woody notes tend to be popular around there"). Never turn this into a question asking the customer what THEY personally like, and never frame it around age or gender ("people your age", "kids there", "women there") — it's a regional signal about the place, nothing else.\n`
    : "";

  return `You are Scent Architect AI, a warm, friendly, and upbeat general assistant for a custom perfume store — happy to chat about everyday things (weather, their city, their day) as well as help build fragrances. Always reply with a positive, encouraging tone.
You help customers build a personalized fragrance by combining note containers into layers (top, middle, base), purely by describing scent notes and character — never by internal product names.
${regionalNotesLine}
Internal catalog (for your reference only — see rules below on how to talk about these):
${catalogLines}

CRITICAL RULE — never break this:
- NEVER say, mention, or hint at the "internal_id" value (the container's Title/product name) in your conversational replies to the customer.
- Only describe containers by their actual scent notes and character (e.g. "a blend of bergamot, cedar, and clove" or "a warm citrus-woody accord"). Speak like a perfumer describing a scent, not a catalog listing a SKU.
- When suggesting a container for any layer, mention only 4-5 of its most distinctive notes — never dump its full note list.
- The internal_id exists only so you can reference the correct container internally when calling the confirm_scent_combination tool. It must never appear in your visible text response.
- When you call confirm_scent_combination, every internal_id must be copied EXACTLY (character for character) from a "[internal_id: ...]" bracket in the catalog above. Never use a note name (e.g. "Pink Pepper") as an internal_id — a note is only ever an ingredient inside a container's Notes list, never a container's own title.
- Each layer must use a DIFFERENT container from every other layer in the same blend — never suggest or confirm the same container twice.
- If a tool call gets rejected because you called it TOO EARLY (not enough containers yet, or before name/location/every layer was actually walked through) — this means you jumped ahead by mistake. Do NOT retry the tool call again next turn. Instead, just continue the normal conversation from wherever it actually is (suggesting containers for the current layer per step 6b, asking its position per step 6d, etc.) across as many real turns as it takes — actually write out the real note suggestions and questions the customer needs to see, don't stall with a placeholder line and don't attempt the tool again until every layer is genuinely chosen and positioned.
- If a tool call gets rejected for a small, correctable reason instead (a wrong/invented internal_id, a missing email, a mismatched note, etc.) — something you can realistically fix immediately with info you already have — call confirm_scent_combination again with corrected values on your VERY NEXT turn, retrying immediately and silently. Never mention "internal IDs", "catalog", "matching", "container", or anything technical about the retry to the customer. If you need to say anything while sorting it out, keep it as natural as "Just a moment while I finalize that for you!" — but only for this kind of small fix, never as a substitute for actually writing out step 6b's real container suggestions.
- If you genuinely can't find a good match for what the customer described (a note/style that isn't in the catalog), never say anything like "that internal ID doesn't exist" or reference IDs/catalog/matching at all. Just say something like "Those exact notes aren't available right now" and immediately suggest 3-4 notes from something close in the catalog instead.
- When you name a container's notes to the customer, copy each note's spelling EXACTLY as it appears after "Notes:" in the catalog above (e.g. if the catalog says "Bergamot, Green Petitgrain", say those exact words) — never rename, reword, or invent a more "poetic" version of a note name. You can still write a natural sentence around them (e.g. "This one leans into Bergamot, Green Petitgrain, and Neroli Blossom"), but the note names themselves must be verbatim matches from the catalog, never paraphrased.
- IMPORTANT — do not confuse the rule above with internal_id: that rule is ONLY about what you SAY to the customer. internal_id is a COMPLETELY SEPARATE field and must ALWAYS be the short TITLE from inside the "[internal_id: ...]" bracket (e.g. "The Opera") — NEVER the Notes list, and NEVER a comma-separated list of note names. If internal_id contains a comma-separated list of notes, that is always wrong.
- If nothing in the catalog is a strong match for what the customer wants, still pick a REAL container from the list above (even an imperfect one) rather than inventing one that doesn't exist — an imperfect real match is always better than a fabricated title.

CONVERSATION FLOW — follow these steps in order:

0. On the customer's first message, greet them warmly and generally, e.g.: "Hi there! 😊 Welcome to Dua Scent Agent! How are you doing today?" Keep it a normal friendly greeting, not fragrance-consultant-sounding yet.

1. Right after that, ask for their name only, e.g.: "Before we get going, what's your name?" Wait until they answer before moving on — you'll need their email too, but only later, once their blend is finalized.

2. Once you have their name, continue the friendly conversation naturally: ask where they live, and respond with a warm, positive line about that region's typical weather/climate (warm and humid, crisp and cold, mild and breezy, etc) — just chat about it like a normal conversation, don't jump straight to fragrance yet.

3. Right after that, share (as a plain, positive STATEMENT, never a question) what scents tend to be popular in that region — see the regional-notes guidance above. Keep it about the region as a place, e.g. "Fragrances with warm, woody notes tend to be popular around there!" NEVER frame this around demographics ("people your age like...", "kids there love...", "women there prefer...") — just the region itself. Do NOT ask the customer what they personally gravitate toward here — there is no "what scents do you like" question in this flow anymore; just share the info and let the conversation flow naturally into the next step.

4. Ask what occasion or purpose they want this fragrance for (e.g. everyday wear, a night out, a gift, a special event). If the customer doesn't answer or moves past it without saying, don't press — just continue to the next step anyway.
   - Feel free to keep the conversation natural and let it flow — you're not limited to only fragrance topics, and it's fine to chat a bit more if the customer wants to.
   - If the customer instead asks about order status, tracking, returns, exchanges, shipping, or store policies, politely let them know that capability isn't available yet in this chat, and suggest they contact the store directly — do not invent order details, policies, or tracking information.
   - Do NOT ask a general "what direction/style do you like — citrus, woody, sweet?" question here or anywhere before step 6. That question belongs ONLY inside step 6a, asked once per individual layer — asking it generally first duplicates step 6a's question and just wastes a turn. Once occasion is answered (or skipped), go straight to step 5.

5. Now transition into building the blend. Ask: "How many containers of notes would you like to combine for your custom fragrance? You'll need at least 2." Do NOT mention any maximum up front.
   - Accept between 2 and 4 layers. If they ask for more than 4, apologize warmly and let them know 4 is the most you can combine in one blend right now, then ask them to pick up to 4.
   - If they don't give a number or seem unsure, mention that most customers go with 3 layers and ask if that works for them — wait for a clear yes before treating 3 as their confirmed count.
   - Remember their confirmed count as the target.

6. For each container, in order:
   a. Ask a preference question to learn their taste for this layer, keeping their earlier preferences/occasion/climate/region in mind. Don't limit this to just fresh/floral/warm-woody — also offer specific gourmand/dessert directions when they fit the catalog, e.g.: "For your first layer, want to lean into that fresh citrus direction, warm & cozy (vanilla, amber, tobacco), floral (rose, jasmine), deep & woody (oud, sandalwood, leather), or something more dessert-like — marshmallow, cotton candy, caramel?" (Adapt naturally for later layers, e.g. "For your next layer, what direction do you want to go?")
   b. Based on their answer, CALL search_containers_for_layer with a query reflecting it (e.g. "woody", "marshmallow"). Do NOT eyeball the catalog above and write out a note list from memory — that has produced fabricated combinations that weren't any single container's real notes. From the tool's real results, suggest 3-4 DIFFERENT containers you have NOT already used for a previous layer — favor ones matching the regional notes signal where there's a genuine fit. For EACH option, list 4-5 of its notes exactly as the tool returned them, as a plain, direct, comma-separated list (never adjectives like "creamy" or "fresh-smelling" standing in for real note names) — e.g. "Option 1: Peppermint, White Chocolate, Marshmallows, Whipped Cream, Rum" / "Option 2: Praline, Lavender, Bergamot, Saffron, Cedar Wood". Never the internal_id, never a container's full note list.
   c. Let the customer pick one of the options, or describe something closer to what they want (e.g. "orange") — if so, CALL search_containers_for_layer again with that term and suggest from ITS real results, never improvised from memory. Before treating any container as confirmed for this layer, its real notes must genuinely relate to what the customer described — if the closest real match still isn't a good fit, say so plainly and offer the closest real alternative instead of forcing a mismatched one through.
   d. Ask which position this layer should be: "Would you like this to be your top note, middle note, or base note?" Before asking, check your own previous messages in this conversation — NEVER re-ask about or reassign a position already confirmed for an earlier layer. Offer only positions not already assigned to a previous layer — UNLESS this is a 4th container and all three positions (top/middle/base) are already taken, in which case only offer "middle" or "base" for this 4th, accent container — NEVER offer or assign "top" to a 4th container, no matter what the customer says.
   e. Once they confirm a position, respond with a short positive line (e.g. "Love that choice!") confirming exactly which notes and which position were just locked in, and move to the next container (repeat from 6a) until you've collected the number of containers they asked for in step 5 — including a 4th layer if that's what they asked for. Never move on to a new layer without having gotten an explicit position answer for the current one first, and never summarize or finalize until EVERY requested layer (not just the first 2 or 3) has been walked through this way.

7. Once ALL requested layers are chosen and positioned, summarize the full blend by describing top/middle/base in terms of notes only, and ask for final confirmation, e.g. "Shall I create this custom blend for you?" In the SAME message, also ask if they have a name in mind for their fragrance (or if you should come up with a unique one for them), AND ask for their email so you can save this build under it. Wait until you have both before continuing.

8. Only once the customer confirms "yes" (or similar) AND has given their email, call the confirm_scent_combination tool with: all confirmed containers and their assigned positions (each a different container, 2-4 total), a customName (the fragrance's own name, e.g. "Karachi Nights" — NOT the customer's personal name; make one up if they didn't give one), a short warm description, the customer's real name from step 1 (customerName), and their email from step 7 (customerEmail — never fabricate this, only use what they actually gave you). This is the only place internal_id should ever appear — never in your visible text.

9. After the tool result comes back, reply with an enthusiastic, positive confirmation that their custom fragrance has been created and is ready.

General guidelines:
- Keep replies conversational, warm, positive, and concise (2-4 sentences per turn).
- Never invent notes or containers from memory — always get them via search_containers_for_layer (steps 6b/6c). A container that's real but was never actually returned by that tool will be rejected when you try to finalize.
- Don't skip steps or ask multiple questions at once — one step at a time, in order.
- If the customer breaks the flow (e.g. starts describing notes before the current layer's container/position is confirmed, or tries to jump straight to naming/email before every requested layer is done), warmly acknowledge what they said, but steer back to finishing the current step first — e.g. "Let's lock in this layer first, then we'll get right to that!" — before moving forward.
- CRITICAL: Never say or imply that a fragrance "has been created", "is ready", or similar in your visible text unless you have ALREADY called confirm_scent_combination in this exact turn and are responding to its result. If the customer just confirmed, you must call the tool THIS turn — do not describe it as done in plain text instead of calling it.
- There is no way to rename or modify a fragrance after confirm_scent_combination has been called — if the customer asks to rename it afterward, tell them you can't change it now, but they're welcome to start a new blend with that name.`;
}

// ============================================================
// 4. TOOL DEFINITION (OpenAI function-calling format)
// ============================================================
const CONFIRM_COMBINATION_TOOL = {
  type: "function",
  function: {
    name: "confirm_scent_combination",
    description: "Call this once the customer has selected, positioned (top/middle/base), and given final confirmation for all note containers they want combined into a custom product.",
    parameters: {
      type: "object",
      properties: {
        containers: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              internal_id: { type: "string", description: "The container's TITLE ONLY — the short text inside the '[internal_id: ...]' bracket in the catalog, e.g. 'The Opera'. This is NEVER the Notes list (e.g. never 'Bergamot, Rose, Musk') — a comma-separated list of notes is always wrong here." },
              position: { type: "string", enum: ["top", "middle", "base"], description: "The fragrance layer this container was assigned to." }
            },
            required: ["internal_id", "position"]
          },
          description: "All confirmed note containers with their assigned positions, minimum 2."
        },
        customName: { type: "string", description: "A unique, creative, personalized name for the FRAGRANCE itself (e.g. 'Karachi Nights') — this is not the customer's own name." },
        description: { type: "string", description: "A short, appealing 1-2 sentence product description." },
        customerNotes: { type: "string", description: "Any additional requests or preferences the customer mentioned that aren't captured by the note selections (e.g. 'extra long-lasting please', 'this is a birthday gift'). Leave empty if the customer didn't mention anything extra." },
        customerName: { type: "string", description: "The customer's own real name, as they gave it earlier in the conversation." },
        customerEmail: { type: "string", description: "The customer's email address, as they gave it earlier in the conversation. Never fabricate this — only use what they actually provided." }
      },
      required: ["containers", "customName", "description", "customerName", "customerEmail"]
    }
  }
};

// Prompting the model to "search the catalog and copy verbatim" was never reliable enough on its
// own — it kept blending several real note names into a plausible-sounding combination that wasn't
// actually any single container's real Notes (verified directly against the CSV: none of its
// "Option 1/2/3" suggestions in a real transcript matched any real container's note set at all).
// Giving it an actual tool call for this, instead of trusting free text, means the note lists it
// can present are mechanically constrained to what a real search actually returns — and every
// internal_id that comes back is recorded server-side (see OFFERED_CONTAINERS below) so the final
// confirm_scent_combination call can be hard-checked against what was really searched, not just
// against whether the title happens to exist anywhere in the catalog.
const SEARCH_CONTAINERS_TOOL = {
  type: "function",
  function: {
    name: "search_containers_for_layer",
    description: "Search the REAL catalog for containers matching a scent direction or specific note the customer mentioned (e.g. 'woody', 'marshmallow', 'orange'). Returns real containers with their actual notes, copied straight from the catalog. You MUST call this before suggesting note options for any layer (step 6b), or when the customer names a more specific note (step 6c) — never invent, blend, or guess at notes from memory; only ever present what this tool actually returns.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The scent direction or note name the customer is interested in for this layer, e.g. 'woody', 'marshmallow', 'orange citrus'." }
      },
      required: ["query"]
    }
  }
};

// ============================================================
// 5. OPENAI API CALL (with tool-use resolution loop)
// ============================================================
async function callOpenAIOnce(apiKey, messages, useTools, forceConfirmTool) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-nano",
      messages,
      ...(useTools ? { tools: [CONFIRM_COMBINATION_TOOL, SEARCH_CONTAINERS_TOOL] } : {}),
      ...(forceConfirmTool
        ? { tool_choice: { type: "function", function: { name: "confirm_scent_combination" } } }
        : {})
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("OpenAI API error:", response.status, errText);
    return null;
  }

  return response.json();
}

// Cheap models sometimes narrate "your fragrance has been created!" without ever calling the
// tool. When the customer's own message is a short, explicit go-ahead, force the tool call on
// that turn instead of hoping the model complies — avoids claiming success with nothing created.
function looksLikeCreateConfirmation(message) {
  if (!message || typeof message !== "string") return false;
  const wordCount = message.trim().split(/\s+/).length;
  return wordCount <= 8 && /creat/i.test(message);
}

// Independent of whatever the model passes as customerEmail — scans the customer's own messages
// directly, so a real email the customer typed is never lost just because the model failed to
// carry it through into the tool call correctly.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
function extractEmailFromHistory(history) {
  for (const msg of history) {
    if (msg.role === "user" && typeof msg.content === "string") {
      const match = msg.content.match(EMAIL_PATTERN);
      if (match) return match[0];
    }
  }
  return null;
}

// The system prompt tells the model to ask about each layer individually until it reaches the
// count the customer asked for in step 5 — but given a single vague answer ("some other like
// modern"), a cheap model will sometimes just fabricate the rest of the layers itself and call
// confirm_scent_combination early, silently delivering fewer layers than requested (e.g. customer
// asks for 4, model finalizes with 3 — passes the plain 2-4 range check, so it isn't caught
// otherwise). Scans short, direct user messages for a standalone 2-4 digit, taking the LAST one
// found so a later correction (e.g. after being told 4 is the max) overrides an earlier ask.
function extractRequestedLayerCount(history) {
  let count = null;
  for (const msg of history) {
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const trimmed = msg.content.trim();
    if (trimmed.split(/\s+/).length > 6) continue;
    const match = trimmed.match(/\b([2-4])\b/);
    if (match) count = parseInt(match[1], 10);
  }
  return count;
}

// Matching the requested layer count isn't enough on its own — a model could still fabricate
// several layers off a single vague reply (as long as the final count happens to add up) without
// ever actually asking the customer to confirm a position for each one individually. Step 6c asks
// this once per layer, so counting how many times that question was actually asked is a direct
// proxy for "was each layer really walked through" — not just "does the final total match".
//
// Deliberately broad: step 6c correctly narrows down which positions it offers as they get taken
// (e.g. layer 1 asks "top, middle, or base?", layer 2 correctly only offers "middle or base?"
// since top is already assigned, and the last layer may only have "base?" left) — an earlier,
// narrower version of this pattern required seeing "top" mentioned, which rejected a conversation
// that was doing exactly the right thing. Matching any single position word near a "?" catches
// all of these regardless of how many options were still available to offer at that point.
const POSITION_QUESTION_PATTERN = /\b(top|middle|base)\b[^?]{0,80}\?/i;
function countPositionQuestionsAsked(history) {
  return history.filter(msg =>
    msg.role === "assistant" && typeof msg.content === "string" && POSITION_QUESTION_PATTERN.test(msg.content)
  ).length;
}

// A blind total count let a genuinely missing position question (e.g. only the 3rd/final layer's
// position was never actually asked) produce a rejection message telling the model to "ask
// position for every layer" — which then re-verified the ALREADY-confirmed 1st and 2nd layers too,
// creating a long, confusing back-and-forth that (in turn) polluted the per-position word matching
// below with unrelated leftover conversation. Checking each DISTINCT position actually used in this
// attempt individually — with its own dedicated "<position> ...?" pattern — pinpoints exactly which
// one(s) still need asking, so the rejection message can name only those, leaving already-confirmed
// layers alone.
function missingPositionQuestions(containers, history) {
  const distinctPositions = [...new Set(containers.map(c => c.position))];
  return distinctPositions.filter(pos => {
    const pattern = new RegExp(`\\b${pos}\\b[^?]{0,80}\\?`, "i");
    return !history.some(msg => msg.role === "assistant" && typeof msg.content === "string" && pattern.test(msg.content));
  });
}

// Mirrors the email gate below: step 7 requires asking about the fragrance's name in the SAME
// message as email, but nothing previously stopped the model from silently defaulting to
// "Custom Blend" without ever actually asking. This checks the question itself was raised at
// some point — not the authenticity of the answer, since the system prompt deliberately allows
// the customer to delegate naming to the AI ("or should I come up with something unique for you").
// Deliberately NOT proximity-constrained (e.g. "name.{0,N}fragrance") — real phrasing varies too
// much in how far apart the two words land in a sentence; requiring both to just appear
// somewhere in the same message is more robust, and "name" alone would false-positive on step 1's
// separate "what's your name?" (the customer's own name), which never also mentions the fragrance.
function wasNamingQuestionAsked(history) {
  return history.some(msg =>
    msg.role === "assistant" && typeof msg.content === "string" &&
    /\bname\b/i.test(msg.content) &&
    /fragrance|blend|scent|custom|unique/i.test(msg.content)
  );
}

// Steps 1-2 ask for the customer's own name and their location/weather before ever getting into
// layer-building — seen skipped entirely when the customer jumps straight to "want make some
// scent special", with the model treating that as license to skip straight to step 5's layer
// count question. Not the authenticity of what they answered, just that the question was raised.
function wasCustomerNameAsked(history) {
  return history.some(msg =>
    msg.role === "assistant" && typeof msg.content === "string" &&
    /what('?s| is) your name|your name\?/i.test(msg.content)
  );
}
const LOCATION_QUESTION_PATTERN = /where (do|are) you (live|from|located|based)|which city|what'?s the weather/i;
function wasLocationAsked(history) {
  return history.some(msg =>
    msg.role === "assistant" && typeof msg.content === "string" &&
    LOCATION_QUESTION_PATTERN.test(msg.content)
  );
}

// Step 5's "how many containers" question was seen getting skipped entirely — the model went
// straight from the regional-notes statement into treating the customer's next reply as a layer-1
// preference, never establishing a target count at all, then just kept accumulating (and silently
// dropping) layers ad hoc for the rest of the conversation.
const LAYER_COUNT_QUESTION_PATTERN = /how many.{0,20}(container|layer)/i;
function wasLayerCountAsked(history) {
  return history.some(msg =>
    msg.role === "assistant" && typeof msg.content === "string" &&
    LAYER_COUNT_QUESTION_PATTERN.test(msg.content)
  );
}

// Layer-specific note matching (segmentCustomerWordsByPosition / customerDescriptiveWords below)
// should only ever look at conversation from the point layer-building actually starts. Greeting,
// name, location small talk, and the regional-notes statement (step 3) aren't about any specific
// layer — but were still leaking into whichever position got confirmed FIRST, since that generic
// text sat in the bucket before the first flush. Concretely: the region step's own "Fragrances
// with warm, WOODY notes tend to be popular" line put the word "woody" into the very first layer's
// segment, which then coincidentally matched a totally unrelated floral container that happened to
// list "Woody Notes" among its real notes — letting a clear mismatch pass the check. Anchoring
// scanning to right after the "how many containers" question removes that pollution at the source.
function findLayerBuildStartIndex(history) {
  const idx = history.findIndex(
    msg => msg.role === "assistant" && typeof msg.content === "string" && LAYER_COUNT_QUESTION_PATTERN.test(msg.content)
  );
  return idx === -1 ? 0 : idx + 1;
}

// Detects the moment the customer signals they want to start building a fragrance — however the
// conversation got there (an unrelated detour into small talk, an emotional check-in, straight in
// from the greeting, etc). Two shapes: an explicit "make/build/create a fragrance" statement, or a
// short affirmative ("yes", "sure", "maybe") replying directly to the assistant's own invitation
// to start building — both seen in practice skipping straight to layer count afterward. Scans the
// whole history (not just the latest message) so it stays true for the rest of the conversation
// once detected, even after the customer's next reply is just their name.
const BUILD_INTENT_PATTERN = /\b(make|build|create|craft|design)\b.{0,20}\b(fragrance|scent|perfume|blend)\b/i;
const BUILD_INVITATION_PATTERN = /\b(build|create|craft|start|design)\b.{0,30}\b(fragrance|scent|perfume|blend)\b/i;
const SHORT_AFFIRMATIVE_PATTERN = /^(yes|yeah|yep|sure|ok(ay)?|alright|maybe|why not|let'?s( do it)?)\b/i;
function hasEnteredBuildPhase(history) {
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const trimmed = msg.content.trim();
    if (BUILD_INTENT_PATTERN.test(trimmed)) return true;
    if (trimmed.split(/\s+/).length <= 4 && SHORT_AFFIRMATIVE_PATTERN.test(trimmed)) {
      const prevAssistant = [...history.slice(0, i)].reverse().find(m => m.role === "assistant");
      if (prevAssistant && typeof prevAssistant.content === "string" && BUILD_INVITATION_PATTERN.test(prevAssistant.content)) {
        return true;
      }
    }
  }
  return false;
}

// Prompting alone doesn't reliably stop a cheap model from narrating its own retry process
// ("I need to double-check the exact internal IDs...") instead of retrying silently. This is a
// safety net: if leaked implementation language slips through anyway, swap the whole reply for
// a generic holding line rather than ever showing the customer internal jargon.
const LEAKED_JARGON_PATTERN = /internal[\s_-]?id|catalog|match(ing|ed)? the (exact|correct)/i;
function sanitizeCustomerFacingText(text) {
  if (!text || !LEAKED_JARGON_PATTERN.test(text)) return text;
  return "Just putting the finishing touches on your blend — one moment!";
}

// The model isn't reliable at following "apologize, don't claim success" once a combination has
// actually been rejected — seen telling the customer their fragrance was "saved and ready" right
// after a tool-call rejection, with no product ever created. Originally only guarded within the
// SAME turn as a rejection (comboRejected), but comboRejected is a per-invocation local that
// resets to false at the start of every fresh callAI call — so once a later turn didn't even
// attempt a tool call (e.g. the customer just said "waiting"), the guard fell through completely
// and the model claimed success with zero protection, in a conversation where nothing had ever
// actually been created. Now applies whenever comboConfirmed is falsy for THIS turn, full stop —
// that's the only thing that actually means a product was just created, regardless of what
// happened (or didn't) earlier in the conversation.
// Deliberately tolerant of interposed words ("has NOW been created", "is ALL set") — real
// phrasing varies enough that a rigid literal-adjacency match missed the exact claims seen in
// practice ("has now been created", "is all set") because of extra words breaking the match.
const FALSE_SUCCESS_CLAIM_PATTERN = /\b(is (now |all )?(ready|set|created|saved|finalized)|has (now |already )?been (created|saved|finalized)|successfully (created|saved|finalized)|ready to (enchant|wear|enjoy|experience))\b/i;
function guardAgainstFalseSuccessClaim(text, comboConfirmed) {
  if (comboConfirmed || !text) return text;
  if (!FALSE_SUCCESS_CLAIM_PATTERN.test(text)) return text;
  return "I'm so sorry — that hasn't actually been finalized yet! Let's pick up right where we left off so I can get your blend created correctly.";
}

// Passing internal_id validation only proves the container is REAL — it says nothing about
// whether it's actually the one the customer described for THAT layer. Seen picking a totally
// unrelated container after a long, confusing conversation — e.g. customer asked for "orange with
// vanilla and honey" on the top layer, and the model finalized that layer with a container whose
// real notes were "Rose, Fruity Notes, Ambergris, Leather, Nutmeg, Cedar, Vanilla, Musk" — sharing
// only the single, very generic word "vanilla" (present in a huge fraction of all containers) and
// nothing else. A single shared word isn't enough evidence on its own — requiring 2 catches this
// without over-rejecting a case where the customer only ever gave one truly specific word (e.g.
// just "oud" for that layer), which is handled by adapting the requirement down to what's
// actually available. Excludes generic conversation/domain filler that would trivially "match"
// almost any container (e.g. "note"/"notes" appears constantly both in customer messages AND in
// compound note-family names throughout the CSV like "Fruity Notes" or "Green Notes").
const DESCRIPTIVE_STOPWORDS = new Set([
  "note", "notes", "fragrance", "scent", "scents", "layer", "layers", "container", "containers",
  "please", "would", "like", "want", "your", "with", "that", "this", "have", "know", "does",
  "which", "type", "some", "good", "perfect", "suggest", "suggestion", "suggestions", "beautiful",
  "always", "everyone", "unique", "taste", "email", "create", "build", "custom", "personalized",
  "personalised", "combine", "combination", "blend", "style", "vibe", "mood", "format", "formate",
  "properly", "specific", "specifically",
  // Lowering the word-length filter to 3 (to catch real short note names like "oud") reintroduces
  // a lot of generic filler that would otherwise have been excluded by length alone.
  "the", "and", "for", "are", "you", "not", "but", "all", "can", "was", "its", "our", "his",
  "her", "out", "get", "got", "one", "two", "day", "way", "new", "old", "big", "low", "yes",
  "sure", "okay", "make", "more"
]);
// Includes BOTH the customer's own words AND the assistant's — the flow now has the assistant
// suggest 3-4 real, catalog-verified containers per layer (step 6b) and lets the customer pick
// tersely ("the second one", "sure, that one"), which never repeats any note name in the
// customer's own text. Scoping this to customer-only words made every container fail forever the
// moment a customer picked that way, since there was nothing real left to match against. The
// assistant's suggested note words are just as valid a signal of "this was actually discussed for
// this layer" — they're already required (by other rules) to be real, verbatim catalog notes.
function customerDescriptiveWords(history) {
  return [...new Set(
    history
      .slice(findLayerBuildStartIndex(history))
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => m.content)
      .join(" ")
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length >= 3 && !DESCRIPTIVE_STOPWORDS.has(w))
  )];
}

// Groups descriptive words (customer's own + the assistant's suggested note words) by which layer
// they were actually said for, using the CUSTOMER's short "top"/"middle"/"base" replies as segment
// boundaries — everything said since the previous boundary (by either party) gets attributed to
// whichever position was just confirmed. Only the customer's reply closes a segment (that's the
// actual confirmation moment); the assistant's own "which position?" question doesn't flush early,
// since the customer hasn't answered yet. Imperfect (a long reply spanning a boundary can bleed
// into the next segment), but far better than treating the whole conversation as one
// undifferentiated bag, which let a container matching ANY layer's discussion pass for EVERY layer
// regardless of which one it actually belonged to.
function segmentCustomerWordsByPosition(history) {
  const segments = { top: [], middle: [], base: [] };
  let bucket = [];
  for (const msg of history.slice(findLayerBuildStartIndex(history))) {
    if ((msg.role !== "user" && msg.role !== "assistant") || typeof msg.content !== "string") continue;
    const trimmed = msg.content.trim();
    const words = trimmed
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length >= 3 && !DESCRIPTIVE_STOPWORDS.has(w) && w !== "top" && w !== "middle" && w !== "base");
    bucket.push(...words);
    if (msg.role === "user") {
      const wordCount = trimmed.split(/\s+/).length;
      const positionMatch = wordCount <= 6 ? trimmed.match(/\b(top|middle|base)\b/i) : null;
      if (positionMatch) {
        segments[positionMatch[1].toLowerCase()].push(...bucket);
        bucket = [];
      }
    }
  }
  return segments;
}

function findUnrelatedContainer(containers, history) {
  const globalWords = customerDescriptiveWords(history);
  if (globalWords.length < 15) return null;
  const segments = segmentCustomerWordsByPosition(history);
  for (const item of containers) {
    const container = findContainerByInternalId(item.internal_id);
    if (!container) continue;
    const notesLower = container.Notes.toLowerCase();
    // Prefer the words actually said for THIS layer; fall back to the whole conversation only if
    // segmentation didn't attribute anything to this position.
    const segmentWords = [...new Set(segments[item.position] || [])];
    const wordsToCheck = segmentWords.length > 0 ? segmentWords : globalWords;
    // Word-boundary match, not substring — plain .includes() let "amber" falsely match inside
    // "ambergris" (a related-sounding but chemically distinct note).
    const matchCount = wordsToCheck.filter(w => new RegExp(`\\b${w}\\b`).test(notesLower)).length;
    const requiredMatches = Math.min(2, wordsToCheck.length);
    if (matchCount < requiredMatches) return item;
  }
  return null;
}

// Recovering from a rejected tool call has been seen re-asking (and getting a NEW answer for) a
// layer's position that was already confirmed earlier, silently changing it — e.g. a layer
// confirmed as "top" gets re-asked and answered "middle" later, so the final blend ends up with
// two containers in "middle" and none in "top" at all. Doubling up a position is only ever valid
// for a genuine 4th accent layer (which itself still requires all 3 canonical positions to be
// used); for 2-3 containers, each one must land on its own distinct position.
function hasInvalidPositionDistribution(containers) {
  const counts = {};
  for (const c of containers) counts[c.position] = (counts[c.position] || 0) + 1;
  const distinctPositions = Object.keys(counts).length;
  if (containers.length <= 3) return distinctPositions !== containers.length;
  if (distinctPositions !== 3 || Object.values(counts).some(n => n > 2)) return true;
  // The 4th, doubled-up accent layer must always land on middle or base — never top.
  return (counts.top || 0) > 1;
}

// Mirrors the email gate: customerName is a required schema field, so the model fabricates one
// (seen deriving "Haseeb Faraz" purely from the local part of an email address, "haseebfaraz2000",
// after the customer's own name was never actually captured — the question got asked, but the
// customer's confused reply was treated as if it had answered it). Requires the submitted name (or
// a real word from it) to actually appear somewhere in the customer's own messages.
function wasRealNameProvided(history, submittedName) {
  if (!submittedName) return false;
  const nameWords = submittedName.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (nameWords.length === 0) return false;
  const customerText = history
    .filter(m => m.role === "user" && typeof m.content === "string")
    .map(m => m.content)
    .join(" ")
    .toLowerCase();
  return nameWords.some(w => new RegExp(`\\b${w}\\b`).test(customerText));
}

async function callAI(history, conversationId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { replyText: "Configuration error: missing API key.", comboConfirmed: null };
  }

  // Checked BEFORE the "create" confirmation intercept below — steps 1-2 (name, location) always
  // come first in the intended flow, so they must win even if the customer's message happens to
  // also contain "creat" (e.g. "Create Fragrance with name of Rise & Fall" is an early aspirational
  // statement, not a final go-ahead, but it used to trigger the name+email ask way too early,
  // before the customer's own name or location had ever been requested).
  if (hasEnteredBuildPhase(history) && !wasCustomerNameAsked(history)) {
    const askText = "That sounds lovely! Before we get going, what's your name?";
    return {
      replyText: askText,
      comboConfirmed: null,
      updatedMessages: [...history, { role: "assistant", content: askText }]
    };
  }
  if (hasEnteredBuildPhase(history) && !wasLocationAsked(history)) {
    const askText = "Nice to meet you! Where do you live? Is the weather warm and humid, crisp and cold, or somewhere in between?";
    return {
      replyText: askText,
      comboConfirmed: null,
      updatedMessages: [...history, { role: "assistant", content: askText }]
    };
  }
  // Seen skipping step 5 (layer count) entirely — going straight from the regional-notes statement
  // into treating the customer's next reply as a layer-1 preference, with no target count ever
  // established, then silently dropping layers ad hoc for the rest of the conversation. Gives the
  // model exactly one free turn after location to optionally ask about occasion (step 4, which is
  // allowed to be skipped) before hard-forcing layer count — otherwise this would also make step 4
  // permanently unreachable by always winning the very next turn after location.
  if (hasEnteredBuildPhase(history) && wasLocationAsked(history) && !wasLayerCountAsked(history)) {
    const locationIdx = history.findIndex(
      msg => msg.role === "assistant" && typeof msg.content === "string" && LOCATION_QUESTION_PATTERN.test(msg.content)
    );
    const userTurnsSinceLocation = history.slice(locationIdx + 1).filter(msg => msg.role === "user").length;
    if (userTurnsSinceLocation >= 2) {
      const askText = "How many containers of notes would you like to combine for your custom fragrance? You'll need at least 2.";
      return {
        replyText: askText,
        comboConfirmed: null,
        updatedMessages: [...history, { role: "assistant", content: askText }]
      };
    }
  }

  const lastUserMessage = [...history].reverse().find(m => m.role === "user" && typeof m.content === "string");
  // Also requires at least one position question to have already been asked — otherwise an early
  // message that merely mentions "creat[e]" (like the example above) gets mistaken for a genuine
  // final go-ahead before any layer has even been discussed.
  const forceConfirmTool = looksLikeCreateConfirmation(lastUserMessage?.content) && countPositionQuestionsAsked(history) > 0;

  // Asking for name/email at final confirmation is a soft prompt instruction the model
  // sometimes skips. Since we already hard-require email before creating anything, intercept
  // deterministically here instead of hoping it remembers to ask — guarantees a clean, consistent
  // question every time, with zero reliance on model behavior.
  if (forceConfirmTool && !extractEmailFromHistory(history)) {
    const askText = "Wonderful! Before I create this, what would you like to name your fragrance (or should I come up with something unique for you), and what email should I save this build under?";
    return {
      replyText: askText,
      comboConfirmed: null,
      updatedMessages: [...history, { role: "assistant", content: askText }]
    };
  }

  let messages = [{ role: "system", content: await buildSystemPrompt(history) }, ...history];
  let comboConfirmed = null;
  let confirmedName = null;
  let confirmedDescription = null;
  let confirmedCustomerNotes = null;
  let confirmedCustomerName = null;
  let confirmedCustomerEmail = null;
  let comboRejected = false;
  let finalText = "";
  let invalidIdFailures = 0;
  let forcedPlainTextNudge = false;

  for (let turn = 0; turn < 3; turn++) {
    // After repeated invalid-ID failures, the model sometimes just keeps inventing fake titles
    // instead of admitting no match exists (seen fabricating things like "Drowning in Vanilla By
    // The Fireplace"). Prompting alone doesn't reliably stop that — force plain text so it
    // physically cannot call the tool again until it's actually found a real match elsewhere
    // in conversation.
    const forcePlainText = invalidIdFailures >= 2;
    if (forcePlainText && !forcedPlainTextNudge) {
      forcedPlainTextNudge = true;
      messages.push({
        role: "user",
        content: "You've tried twice and still haven't matched anything real in the catalog for what the customer described. Do NOT call any tool this turn. Instead, tell the customer warmly that those exact notes aren't available right now, and suggest 3-4 notes from something else in the catalog above that's close to what they asked for."
      });
    }

    const data = await callOpenAIOnce(apiKey, messages, !forcePlainText, forceConfirmTool && turn === 0 && !forcePlainText);
    if (!data) {
      return { replyText: "Sorry, I'm having trouble reaching the fragrance engine right now.", comboConfirmed: null };
    }

    const choice = data.choices[0];
    const message = choice.message;
    const toolCalls = message.tool_calls;

    if (choice.finish_reason === "tool_calls" && toolCalls && toolCalls.length > 0) {
      messages.push({ role: "assistant", content: message.content || null, tool_calls: toolCalls });

      for (const toolCall of toolCalls) {
        let toolResultContent = "Combination noted internally. Do not call any more tools. Now respond directly to the customer in 2-3 warm sentences confirming their custom blend has been created and is ready.";

        if (toolCall.function.name === "confirm_scent_combination") {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const containers = args.containers || [];
            const invalidIds = containers
              .map(c => c.internal_id)
              .filter(id => !findContainerByInternalId(id));

            const offeredSet = getOfferedSet(conversationId);
            const neverOfferedIds = containers
              .map(c => c.internal_id)
              .filter(id => findContainerByInternalId(id) && !offeredSet.has(id));

            const normalizedIds = containers.map(c => normalizeForMatch(c.internal_id));
            const duplicateIds = [...new Set(
              normalizedIds.filter((id, i) => normalizedIds.indexOf(id) !== i)
            )];
            const requestedLayerCount = extractRequestedLayerCount(history);
            const unrelatedContainer = findUnrelatedContainer(containers, history);

            if (containers.length < 2) {
              // minItems is advisory too — the model sometimes calls this early, mid-layer,
              // instead of waiting for final confirmation of the whole blend.
              comboRejected = true;
              toolResultContent = `Error: confirm_scent_combination was called with only ${containers.length} container(s). This tool is ONLY for the FINAL confirmed blend (at least 2 containers, all positioned) — not for picking a single layer. Do NOT retry this tool call now — go back to plain conversation instead: suggest 3-4 real containers for whichever layer you're currently on (step 6b), let the customer pick one, ask its position (step 6d), and keep walking through the remaining layers one at a time over as many turns as it takes. Only call this tool again once every layer the customer asked for is actually chosen and positioned.`;
            } else if (containers.length > 4) {
              // Function schemas (maxItems) are advisory for OpenAI, not enforced — a cheap model
              // can still send more. Reject rather than silently truncating or overcharging later.
              comboRejected = true;
              toolResultContent = `Error: this blend has ${containers.length} containers, but the maximum is 4. Ask the customer to narrow it down to 4 or fewer, then call confirm_scent_combination again.`;
            } else if (!wasCustomerNameAsked(history)) {
              // Steps 1-2 got skipped entirely when the customer jumped straight into "I want a
              // special scent" and the model treated that as license to skip to layer-building.
              comboRejected = true;
              toolResultContent = `Error: you never asked the customer for their own name (step 1 of the conversation flow). Do NOT call this tool yet. Go back, warmly ask for their name, and continue the flow from there before eventually returning to finalize this blend.`;
            } else if (!wasLocationAsked(history)) {
              comboRejected = true;
              toolResultContent = `Error: you never asked the customer where they live (step 2 of the conversation flow). Do NOT call this tool yet. Go back, ask where they live and chat briefly about the weather there, and continue the flow from there before eventually returning to finalize this blend.`;
            } else if (requestedLayerCount !== null && containers.length < requestedLayerCount) {
              // Passes the plain 2-4 range check above but doesn't match what the customer
              // actually asked for in step 5 — the model finalized early instead of asking about
              // every remaining layer. Only rejects UNDER-delivery (fewer than requested) — a
              // bot-initiated, customer-approved extra layer added later (e.g. "want to add a
              // fourth layer?" / "make it musky") legitimately raises the real count without the
              // customer ever typing a literal digit, so requestedLayerCount can be stale-low.
              // Rejecting that case too caused an unrecoverable loop: every retry had more
              // containers than the stale count, so this gate rejected every single attempt.
              comboRejected = true;
              toolResultContent = `Error: the customer asked for ${requestedLayerCount} containers, but this blend only has ${containers.length}. Do NOT call this tool yet. Continue asking about each remaining layer (preference, then a suggested container, then its position) one at a time until you have all ${requestedLayerCount}, THEN summarize and ask for final confirmation before calling confirm_scent_combination again.`;
            } else if (missingPositionQuestions(containers, history).length > 0) {
              // The total count can match while one specific layer was never actually walked
              // through (e.g. the model inferred the last layer's position by elimination instead
              // of asking) — checks each distinct position individually so the message below can
              // name exactly which one is missing, instead of telling the model to re-verify EVERY
              // layer (which re-litigated already-confirmed ones, producing a long, confusing
              // back-and-forth that went on to corrupt the per-position word matching further down).
              const missing = missingPositionQuestions(containers, history);
              comboRejected = true;
              toolResultContent = `Error: you never actually asked the customer which position ${missing.map(p => `"${p}"`).join(" / ")} should be for its layer. The OTHER layers are already confirmed — do NOT re-ask about those. Just ask which layer should be the ${missing.join(" or ")} note, then call confirm_scent_combination again.`;
            } else if (invalidIds.length > 0) {
              // Model hallucinated a title (often a note name — or, since real titles almost
              // never contain a comma, a whole notes LIST — mistaken for a container title).
              // Reject and let it self-correct instead of crashing later during product creation.
              invalidIdFailures++;
              comboRejected = true;
              const looksLikeNotesList = invalidIds.some(id => id.includes(","));
              const notesListWarning = looksLikeNotesList
                ? ` At least one of these looks like a comma-separated NOTES list, not a title — internal_id must be the short container TITLE (e.g. "The Opera"), never the Notes list.`
                : "";
              toolResultContent = `Error: these internal_id values don't exist in the catalog: ${invalidIds.join(", ")}.${notesListWarning} internal_id must be copied EXACTLY from a "[internal_id: ...]" bracket above — never a note name or invented title. Re-check the catalog and call confirm_scent_combination again with corrected values.`;
            } else if (neverOfferedIds.length > 0) {
              // Stronger than invalidIds above — a title can be a REAL container and still never
              // have actually been searched/shown to this customer. Verified directly against the
              // CSV that the model's live "Option 1/2/3" suggestions were sometimes blended from
              // several different real containers' notes rather than being any single container's
              // actual list — meaning whatever it eventually finalized with here could be a real
              // title it merely recalled from the full catalog, not one it genuinely searched and
              // presented. Requiring every finalized internal_id to have actually come back from a
              // search_containers_for_layer call closes that gap at the source.
              invalidIdFailures++;
              comboRejected = true;
              toolResultContent = `Error: these internal_id values are real catalog titles, but were never actually returned by a search_containers_for_layer call in this conversation: ${neverOfferedIds.join(", ")}. Do NOT guess a title from memory — call search_containers_for_layer with a query matching what the customer described for that layer, then use one of ITS real results, then call confirm_scent_combination again.`;
            } else if (duplicateIds.length > 0) {
              // Same container reused across two layers — each layer must be a distinct container.
              comboRejected = true;
              toolResultContent = `Error: the same container was used for more than one layer. Each layer must use a DIFFERENT container. Pick a different container for one of the duplicated layers and call confirm_scent_combination again.`;
            } else if (hasInvalidPositionDistribution(containers)) {
              // Re-asking (and getting a changed answer for) an already-confirmed layer's position
              // can leave two containers sharing one position and none in another — only valid for
              // a genuine 4th accent layer, never for a 2-3 container blend.
              comboRejected = true;
              if (containers.length <= 3) {
                toolResultContent = `Error: this ${containers.length}-container blend has two containers sharing the same position, leaving another position unused. Each of the ${containers.length} containers must have its own distinct position (top/middle/base) — double-checking earlier positions you already confirmed, re-ask the customer to clarify which container goes in whichever position is missing, then call confirm_scent_combination again.`;
              } else {
                const posCounts = {};
                for (const c of containers) posCounts[c.position] = (posCounts[c.position] || 0) + 1;
                toolResultContent = (posCounts.top || 0) > 1
                  ? `Error: this 4-container blend has two containers both assigned to "top". The 4th, accent container must always double up into "middle" or "base" — never "top". Re-ask the customer which of middle or base this extra layer should blend into, then call confirm_scent_combination again.`
                  : `Error: this 4-container blend doesn't use all three positions (top/middle/base) correctly — exactly one position should have two containers (the accent layer, which must be middle or base, never top), the other two should have exactly one each. Re-check the positions with the customer and call confirm_scent_combination again.`;
              }
            } else if (unrelatedContainer) {
              comboRejected = true;
              toolResultContent = `Error: the container chosen for the ${unrelatedContainer.position} layer ("${unrelatedContainer.internal_id}") doesn't match anything the customer actually described wanting anywhere in this conversation. Do NOT call this tool yet. Re-read what the customer said they wanted for that specific layer, and pick a real container from the catalog above whose notes actually reflect that — call confirm_scent_combination again with a corrected internal_id for that layer.`;
            } else if (!extractEmailFromHistory(history)) {
              // args.customerEmail is NOT trusted on its own — customerEmail is a required schema
              // field, and a cheap model asked to always fill a required field will fabricate a
              // plausible-looking one (e.g. "customer@example.com") rather than leave it blank or
              // ask a question, exactly like it fabricates internal_id values elsewhere. The only
              // trustworthy source is text the customer actually typed, so the email must be
              // independently findable in their own messages — never taken from the tool args alone.
              // Critically: tell it to STOP calling tools and ask a real question instead, or it
              // just retries the same broken call forever ("just a moment" on loop).
              comboRejected = true;
              toolResultContent = `Error: no customer email found. Do NOT call this tool again yet. Instead, respond to the customer right now with a plain question asking for their email address, and wait for their reply. Only call confirm_scent_combination again once they've actually given you one.`;
            } else if (!wasRealNameProvided(history, args.customerName)) {
              // Unlike the fragrance's own name, there's no "or should I come up with one"
              // delegation option for the CUSTOMER'S name — it must be something they actually
              // typed. Seen the model treat a confused/deflecting reply to "what's your name?" as
              // if it had answered, then fabricate a plausible name later derived from their email
              // address instead (e.g. "Haseeb Faraz" from "haseebfaraz2000@gmail.com").
              comboRejected = true;
              toolResultContent = `Error: no real customer name was found anywhere in their own messages — "${args.customerName}" looks guessed rather than actually given. Do NOT call this tool again yet. Ask the customer plainly for their name, and wait for their actual reply before calling this again.`;
            } else if (!wasNamingQuestionAsked(history)) {
              // Without this, the model can silently default customName to something generic
              // (e.g. "Custom Blend") without ever having asked — this doesn't require the name
              // be customer-given (the system prompt allows delegating to the AI), just that the
              // question was actually raised at some point.
              comboRejected = true;
              toolResultContent = `Error: you haven't asked the customer what they'd like to name their fragrance yet (or whether you should come up with one for them). Do NOT call this tool again yet. Ask them now, and wait for their reply.`;
            } else {
              comboRejected = false;
              comboConfirmed = containers;
              confirmedName = args.customName || "Custom Blend";
              confirmedDescription = args.description || "";
              confirmedCustomerNotes = args.customerNotes || "";
              confirmedCustomerName = args.customerName || "";
              confirmedCustomerEmail = extractEmailFromHistory(history);
              finalText = buildConfirmationText(comboConfirmed, confirmedName, confirmedCustomerName);
            }

            if (comboRejected) {
              console.log("Tool call rejected:", toolResultContent);
            }
          } catch (e) {
            console.error("Failed to parse tool arguments:", e);
            toolResultContent = "Error: couldn't parse those tool call arguments — call confirm_scent_combination again with valid JSON.";
          }
        } else if (toolCall.function.name === "search_containers_for_layer") {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const query = args.query || "";
            const matches = scoreContainersFor(query).slice(0, 4);
            if (matches.length === 0) {
              toolResultContent = `No real containers matched "${query}". Tell the customer plainly that those exact notes aren't available right now, and try search_containers_for_layer again with a related term (e.g. a nearby note family) — do not invent notes yourself.`;
            } else {
              const offered = getOfferedSet(conversationId);
              const lines = matches.map(c => {
                offered.add(c.Title);
                return `- [internal_id: ${c.Title}] Notes: ${c.Notes}`;
              });
              toolResultContent = `Real containers found for "${query}":\n${lines.join("\n")}\n\nPresent 3-4 of these to the customer as your suggested options, each showing only 4-5 of its notes copied EXACTLY as listed above — never add, remove, or blend in any note that isn't shown here. Never mention "internal_id" or any container's title to the customer.`;
            }
          } catch (e) {
            console.error("Failed to parse search_containers_for_layer arguments:", e);
            toolResultContent = "Error: couldn't parse those tool call arguments — call search_containers_for_layer again with valid JSON.";
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResultContent
        });
      }

      // A successful confirmation already has its customer-facing reply built deterministically
      // above (buildConfirmationText) — stop here instead of looping back for another model turn,
      // which is exactly where free-generated hallucination would otherwise creep back in.
      if (finalText) {
        messages.push({ role: "assistant", content: finalText });
        break;
      }
      continue;
    }

    finalText = guardAgainstFalseSuccessClaim(sanitizeCustomerFacingText(message.content || ""), comboConfirmed);
    messages.push({ role: "assistant", content: finalText });
    break;
  }

  if (!finalText) {
    const nudgeContent = comboRejected && !comboConfirmed
      ? "The last combination you tried to confirm didn't match anything in the catalog. Apologize warmly, and ask the customer to pick a different note direction for that layer so you can try again. Do not call any tools."
      : "Please reply to the customer now in 2-3 warm sentences. Do not call any tools.";
    const nudge = [...messages, { role: "user", content: nudgeContent }];
    const data = await callOpenAIOnce(apiKey, nudge, false);
    if (data) {
      finalText = guardAgainstFalseSuccessClaim(sanitizeCustomerFacingText(data.choices[0]?.message?.content || ""), comboConfirmed);
      messages.push({ role: "user", content: nudgeContent });
      messages.push({ role: "assistant", content: finalText });
    }
  }

  // Strip the system message before persisting (it's rebuilt fresh each call)
  const persistedMessages = messages.filter(m => m.role !== "system");

  return {
    replyText: finalText || (comboRejected && !comboConfirmed
      ? "Sorry, I couldn't quite match that last combination — could we try a different note direction for that layer?"
      : "Great choice! Let's get that crafted for you."),
    comboConfirmed,
    confirmedName,
    confirmedDescription,
    confirmedCustomerNotes,
    confirmedCustomerName,
    confirmedCustomerEmail,
    updatedMessages: persistedMessages
  };
}

// ============================================================
// 6. DYNAMIC PRODUCT CREATION
// ============================================================
const POSITION_OPTION_NAMES = { top: "Top Note", middle: "Middle Note", base: "Base Note" };

// Keep the variant's option value readable: at most 5 notes per container, joined for multiple
// containers sharing a position (accent layers).
function summarizeNotesForOption(notes, max = 5) {
  return notes
    .split(",")
    .map(n => n.trim())
    .filter(Boolean)
    .slice(0, max)
    .join(", ");
}

// Builds the customer-facing confirmation message deterministically from the REAL confirmed
// containers' REAL Notes column, instead of letting the model freely re-narrate the blend from
// memory on its next turn — seen inventing notes that don't actually exist in the container it
// just validly picked (e.g. describing a real container as having a "bright orange top" when its
// actual Notes column has no orange at all). The internal_id passing validation only guarantees
// the ID is real; it says nothing about whether the model's own prose describing it is accurate.
function buildConfirmationText(containers, customName, customerName) {
  const notesByPosition = {};
  for (const item of containers) {
    const container = findContainerByInternalId(item.internal_id);
    const summary = summarizeNotesForOption(container?.Notes || "", 4);
    notesByPosition[item.position] = notesByPosition[item.position]
      ? `${notesByPosition[item.position]} + ${summary}`
      : summary;
  }
  const layerLines = ["top", "middle", "base"]
    .filter(position => notesByPosition[position])
    .map(position => `${position} note: ${notesByPosition[position]}`);
  const nameAddress = customerName ? `, ${customerName}` : "";
  return `Your custom fragrance "${customName}" is ready${nameAddress}! It layers ${layerLines.join("; ")} — I hope it's absolutely perfect for you!`;
}

// Used only when a container's PricePer5ml is missing/blank in the CSV — shouldn't happen now
// that every row is populated, but keeps product creation from ever computing a $0 price.
const FALLBACK_PRICE_PER_5ML = 20;

// Every bottle is a fixed 34ml, ~30% notes concentrate / 70% alcohol by volume — the concentrate
// total (not the bottle size) is fixed, split evenly across however many layers the customer
// picked. This isn't something the customer chooses, so it's computed here, not left to the model.
const BOTTLE_SIZE_ML = 34;
const CONCENTRATE_RATIO = 0.3;

// Real animated bottle renders hosted on the shop's own CDN — a different one for a 2-layer
// blend vs. a 3+ layer blend, since the render itself shows the layering.
const BOTTLE_IMAGE_2_LAYER = "https://cdn.shopify.com/s/files/1/1005/4379/1236/files/animated_bottle.png?v=1784530062";
const BOTTLE_IMAGE_3PLUS_LAYER = "https://cdn.shopify.com/s/files/1/1005/4379/1236/files/animated_bottle-3layered.png?v=1784530061";

// Shopify caps every product at 3 options total — Top Note/Middle Note/Base Note already use
// all 3 slots for a 3-layer blend, so there's no room for a separate option to track the ratio a
// customer lands on after dragging the storefront sliders. Instead, the ratio is encoded as a
// "(NN%)" suffix on each position's own option value — e.g. "Lime, Pink Pepper, Clary Sage,
// Juniper, Rose Water (5%)" — which still produces a genuinely distinct, separately-priced
// variant per ratio (Shopify variants are unique by their full combination of option values)
// without needing an extra option slot. MUST stay in sync with the identical helpers in
// app/routes/api.save-build.jsx.
const RATIO_SUFFIX_PATTERN = / \(\d+%\)$/;
function stripRatioSuffix(value) {
  return value.replace(RATIO_SUFFIX_PATTERN, "");
}
function withRatioSuffix(baseValue, pct) {
  return `${stripRatioSuffix(baseValue)} (${Math.round(pct)}%)`;
}

async function createDynamicProduct(admin, shopDomain, comboConfirmed, customName, description, customerNotes, customerName, customerEmail) {
  const perLayerMl = (BOTTLE_SIZE_ML * CONCENTRATE_RATIO) / comboConfirmed.length;

  const layerDetails = comboConfirmed.map(item => {
    const container = findContainerByInternalId(item.internal_id);
    if (!container) throw new Error(`Container "${item.internal_id}" not found.`);
    const parsedPrice = parseFloat(container.PricePer5ml);
    return {
      title: item.internal_id,
      notes: container.Notes || "",
      position: item.position,
      quantityMl: perLayerMl,
      pricePer5ml: isNaN(parsedPrice) ? FALLBACK_PRICE_PER_5ML : parsedPrice
    };
  });

  // Total price = each container's per-5ml rate applied to however much of it went into the blend.
  const computedPrice = layerDetails.reduce(
    (sum, layer) => sum + (layer.pricePer5ml / 5) * layer.quantityMl,
    0
  );
  const FIXED_PRICE = computedPrice.toFixed(2);

  // Group by position so each layer becomes one product option, and its value is what
  // shows up as the variant title — visible on the order line item at checkout.
  const notesByPosition = {};
  const mlByPosition = {};
  let totalLayerMl = 0;
  for (const layer of layerDetails) {
    const summary = summarizeNotesForOption(layer.notes);
    notesByPosition[layer.position] = notesByPosition[layer.position]
      ? `${notesByPosition[layer.position]} + ${summary}`
      : summary;
    mlByPosition[layer.position] = (mlByPosition[layer.position] || 0) + layer.quantityMl;
    totalLayerMl += layer.quantityMl;
  }
  // The ratio suffix on each option's value (see comment above RATIO_SUFFIX_PATTERN) is what
  // lets the storefront's note-ratio sliders (see custom-scent-product theme section) give each
  // saved ratio its own separately-priced variant on every "Save Build" — without it, Shopify
  // carts would always show a variant's *current* price, so anyone re-saving a different ratio
  // later would silently change the price of an item already sitting in someone else's cart.
  const productOptions = ["top", "middle", "base"]
    .filter(position => notesByPosition[position])
    .map(position => ({
      name: POSITION_OPTION_NAMES[position],
      values: [{ name: withRatioSuffix(notesByPosition[position], (mlByPosition[position] / totalLayerMl) * 100) }]
    }));

  const notesSummaryHtml = ["top", "middle", "base"]
    .filter(position => notesByPosition[position])
    .map(position => `<strong>${POSITION_OPTION_NAMES[position]}s:</strong> ${notesByPosition[position]}`)
    .join("<br>");

  const fullDescription = `${description}` +
    `<p>${notesSummaryHtml}</p>` +
    `<p><strong>Longevity:</strong> A rich, parfum-concentration blend crafted for long-lasting wear.</p>` +
    (customerNotes ? `<p><strong>Customer notes:</strong> ${customerNotes}</p>` : "");

  const createResponse = await admin.graphql(`
    mutation createProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product { id handle }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      input: {
        title: customName,
        descriptionHtml: fullDescription,
        vendor: customerName || customerEmail || undefined,
        status: "ACTIVE",
        templateSuffix: "custom-scent",
        productOptions,
        metafields: [
          {
            namespace: "custom",
            key: "note_composition",
            type: "json",
            value: JSON.stringify({ layers: layerDetails, customerNotes: customerNotes || "" })
          },
          {
            // Admin-only by default (not exposed to the Storefront API) — keeps the customer's
            // name/email out of any public-facing page while still letting staff look up who a
            // custom product belongs to.
            namespace: "custom",
            key: "customer_name",
            type: "single_line_text_field",
            value: customerName || ""
          },
          {
            namespace: "custom",
            key: "customer_email",
            type: "single_line_text_field",
            value: customerEmail || ""
          }
        ]
      }
    }
  });

  const createJson = await createResponse.json();
  const product = createJson.data?.productCreate?.product;
  const createErrors = createJson.data?.productCreate?.userErrors;

  if (!product || (createErrors && createErrors.length > 0)) {
    throw new Error(createErrors?.map(e => e.message).join(", ") || "Product creation failed.");
  }

  // Custom-built products have no real product photo — without one, collection/search grids show
  // a blank placeholder box (as seen in "Your Design"). Attach the real bottle image hosted on
  // Shopify's own CDN — a different animation for a 2-layer blend vs. a 3+ layer one.
  const bottleImageUrl = comboConfirmed.length === 2 ? BOTTLE_IMAGE_2_LAYER : BOTTLE_IMAGE_3PLUS_LAYER;
  try {
    const mediaResponse = await admin.graphql(`
      mutation attachBottleImage($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          mediaUserErrors { field message }
        }
      }
    `, {
      variables: {
        productId: product.id,
        media: [{
          mediaContentType: "IMAGE",
          originalSource: bottleImageUrl,
          alt: customName
        }]
      }
    });
    const mediaJson = await mediaResponse.json();
    const mediaErrors = mediaJson.data?.productCreateMedia?.mediaUserErrors;
    if (mediaErrors && mediaErrors.length > 0) {
      console.error("productCreateMedia returned mediaUserErrors:", JSON.stringify(mediaErrors));
    }
  } catch (mediaErr) {
    console.error("Failed to attach bottle image:", mediaErr.message || mediaErr);
    // Don't fail the whole product just because the image attach failed.
  }

  // New products aren't published anywhere by default — publish to every sales channel the app
  // can see so the customer can actually buy it, not just view it in the admin.
  try {
    const publicationsResponse = await admin.graphql(`
      query getPublications {
        publications(first: 25) { nodes { id } }
      }
    `);
    const publicationsJson = await publicationsResponse.json();
    const publicationIds = publicationsJson.data?.publications?.nodes?.map(n => n.id) || [];
    console.log("Publications lookup:", JSON.stringify({ count: publicationIds.length, errors: publicationsJson.errors }));

    if (publicationIds.length > 0) {
      const publishResponse = await admin.graphql(`
        mutation publishToAllChannels($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            userErrors { field message }
          }
        }
      `, {
        variables: {
          id: product.id,
          input: publicationIds.map(pubId => ({ publicationId: pubId }))
        }
      });
      const publishJson = await publishResponse.json();
      const publishErrors = publishJson.data?.publishablePublish?.userErrors;
      if (publishErrors && publishErrors.length > 0) {
        console.error("publishablePublish returned userErrors:", JSON.stringify(publishErrors));
      }
    }
  } catch (pubErr) {
    console.error("Failed to publish product to sales channels:", pubErr.message || pubErr);
    // Don't fail the whole product just because publishing failed — it'll just need publishing
    // manually in admin.
  }

  const variantsResponse = await admin.graphql(`
    query getVariants($id: ID!) {
      product(id: $id) { variants(first: 1) { edges { node { id } } } }
    }
  `, { variables: { id: product.id } });
  const variantsJson = await variantsResponse.json();
  const defaultVariantId = variantsJson.data?.product?.variants?.edges?.[0]?.node?.id;

  // Custom fragrances are made to order — there's no real stock count to track. Leaving the
  // variant untracked (Shopify's own default for a fresh variant) means it's always purchasable,
  // with no location/quantity bookkeeping needed at all.
  if (defaultVariantId) {
    await admin.graphql(`
      mutation setPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          product { id }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        productId: product.id,
        variants: [{ id: defaultVariantId, price: FIXED_PRICE, inventoryItem: { tracked: false } }],
      },
    });
  }

  const cleanShopDomain = shopDomain.replace(/^https?:\/\//, '');
  const productUrl = `https://${cleanShopDomain}/products/${product.handle}`;

  return { productUrl, totalPrice: parseFloat(FIXED_PRICE) };
}

// ============================================================
// 7. LOADER — handles history fetch (GET) requests
// ============================================================
export async function loader({ request }) {
  const url = new URL(request.url);
  const isHistoryRequest = url.searchParams.get("history") === "true";
  const conversationId = url.searchParams.get("conversation_id");

  if (isHistoryRequest) {
    const history = conversationId && CONVERSATIONS.has(conversationId)
      ? CONVERSATIONS.get(conversationId)
      : [];

    const messages = history
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim() !== "")
      .map(m => ({ role: m.role, content: m.content }));

    return new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  return new Response(JSON.stringify({ messages: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// ============================================================
// 8. ACTION — handles incoming chat messages (POST)
// ============================================================
export async function action({ request }) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await request.json();

    // Prefer the shop domain the theme block actually knows about (injected via Liquid as
    // {{ shop.permanent_domain }}) over guessing from the Origin header — Origin reflects
    // whatever's actually hosting the storefront request (e.g. a local theme preview port),
    // which isn't a valid shop domain and made `unauthenticated.admin()` reject it outright.
    const originHeader = request.headers.get("Origin") || "";
    const originShopDomain = originHeader.replace(/^https?:\/\//, '').split('/')[0];
    let shopDomain = body.shop_domain || originShopDomain;
    if (!shopDomain || !shopDomain.includes(".")) {
      shopDomain = "test-3d-products.myshopify.com";
    }
    console.log("Shop domain resolution:", JSON.stringify({ fromBody: body.shop_domain, fromOrigin: originShopDomain, resolved: shopDomain }));

    let admin = null;
    try {
      const result = await unauthenticated.admin(shopDomain);
      admin = result.admin;
      console.log("Successfully verified session credentials for:", shopDomain);
    } catch (authErr) {
      console.error("Admin verification session lookup failure:", authErr.message);
    }

    const userMessage = body.message || "";
    const { id: conversationId, history } = getConversation(body.conversation_id);

    history.push({ role: "user", content: userMessage });

    const { replyText, comboConfirmed, confirmedName, confirmedDescription, confirmedCustomerNotes, confirmedCustomerName, confirmedCustomerEmail, updatedMessages } = await callAI(history, conversationId);

    CONVERSATIONS.set(conversationId, updatedMessages || history);

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        send({ type: "id", conversation_id: conversationId });
        send({ type: "chunk", chunk: replyText });
        send({ type: "message_complete" });

        if (comboConfirmed && comboConfirmed.length >= 2) {
          console.log("Combo confirmed:", comboConfirmed);
          send({ type: "product_creating" });

          if (!admin) {
            const productError = "Product creation is unavailable right now (session handshake failed).";
            console.error(productError);
            send({ type: "product_error", error: productError });
          } else {
            try {
              const productResult = await createDynamicProduct(admin, shopDomain, comboConfirmed, confirmedName, confirmedDescription, confirmedCustomerNotes, confirmedCustomerName, confirmedCustomerEmail);
              console.log("Dynamic product created successfully:", productResult.productUrl);
              send({ type: "product_created", url: productResult.productUrl, price: productResult.totalPrice });
            } catch (err) {
              console.error("Dynamic product creation failed:", err);
              send({ type: "product_error", error: err.message });
            }
          }
        }

        send({ type: "end_turn" });
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });

  } catch (err) {
    console.error("Action error:", err);
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "Error processing request." })}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  }
}