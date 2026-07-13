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

// ============================================================
// 1. DATASET ENGINE LAYER
// ============================================================
let SCENT_CONTAINERS = [];
let DATASET_LOAD_ERROR = null;
try {
  const csvPath = path.join(process.cwd(), "data", "Notes-Extraction-Separated.csv");
  if (fs.existsSync(csvPath)) {
    const fileContent = fs.readFileSync(csvPath, "utf-8");
    SCENT_CONTAINERS = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    if (SCENT_CONTAINERS.length === 0) {
      DATASET_LOAD_ERROR = `CSV at ${csvPath} parsed to 0 rows — file may be empty or malformed.`;
    } else if (!("Title" in SCENT_CONTAINERS[0])) {
      DATASET_LOAD_ERROR = `CSV at ${csvPath} has no "Title" column (found columns: ${Object.keys(SCENT_CONTAINERS[0]).join(", ")}). Container lookups will fail for every product.`;
    }
    if (DATASET_LOAD_ERROR) {
      console.error(`[Dataset Engine] ${DATASET_LOAD_ERROR}`);
    } else {
      console.log(`[Dataset Engine] Successfully indexed ${SCENT_CONTAINERS.length} fragrance profiles.`);
    }
  } else {
    DATASET_LOAD_ERROR = `CSV file not found at: ${csvPath}. Product creation will fail until this file is added.`;
    console.error(`[Dataset Engine] ${DATASET_LOAD_ERROR}`);
  }
} catch (error) {
  DATASET_LOAD_ERROR = `Dataset generation lookup failure: ${error.message}`;
  console.error(`[Dataset Engine] ${DATASET_LOAD_ERROR}`, error);
}

function normalizeForMatch(str) {
  return String(str).normalize("NFC").trim().toLowerCase();
}

function findContainerByInternalId(internal_id) {
  if (!internal_id) return null;
  const target = normalizeForMatch(internal_id);
  return SCENT_CONTAINERS.find(c => normalizeForMatch(c.Title) === target) || null;
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

// ============================================================
// 3. SYSTEM PROMPT
// ============================================================
function buildSystemPrompt() {
  const catalogLines = SCENT_CONTAINERS.slice(0, 150).map(c =>
    `- [internal_id: ${c.Title || "Untitled"}] Notes: ${c.Notes || "no notes listed"}`
  ).join("\n");

  return `You are Scent Architect AI, a fragrance consultant for a custom perfume store.
You help customers build a personalized fragrance by combining note containers into layers (top, middle, base), purely by describing scent notes and character — never by internal product names.

Internal catalog (for your reference only — see rules below on how to talk about these):
${catalogLines}

CRITICAL RULE — never break this:
- NEVER say, mention, or hint at the "internal_id" value (the container's Title/product name) in your conversational replies to the customer.
- Only describe containers by their actual scent notes and character (e.g. "a blend of bergamot, cedar, and clove" or "a warm citrus-woody accord"). Speak like a perfumer describing a scent, not a catalog listing a SKU.
- The internal_id exists only so you can reference the correct container internally when calling the confirm_scent_combination tool. It must never appear in your visible text response.

CONVERSATION FLOW — follow these steps in order:

0. On the customer's first message, greet them warmly and briefly list what you can help with, similar to: "Hello! Welcome to our store. 😊 How can I help you today? I can assist with: Finding products you're looking for, Order status or tracking, Returns and exchanges, Shipping and store policies, or building you a custom fragrance blend! What can I do for you?"
   - If the customer asks about order status, tracking, returns, exchanges, shipping, or store policies, politely let them know that capability isn't available yet in this chat, and suggest they contact the store directly for that — do not invent order details, policies, or tracking information.
   - If the customer expresses interest in finding a product or building a custom fragrance, continue to step 1 below.

1. Start by asking: "How many containers of notes would you like to combine for your custom fragrance? You'll need at least 2 — most fragrances use 2 or 3 layers (top, middle, base)."
   Wait for the customer to give a number (minimum 2). Remember this as their target count.

2. For each container, in order:
   a. Ask a preference question to learn their taste for this layer, e.g.: "To get started, tell me a bit about what you love: do you lean more toward warm & cozy scents (vanilla, amber, tobacco), fresh & citrusy (bergamot, lemon, mandarin), floral (rose, jasmine), or deep & woody (oud, sandalwood, leather)?" (Adapt this question naturally for later containers, e.g. "For your next layer, what direction do you want to go?")
   b. Based on their answer, suggest ONE specific note combination from the catalog above that matches their taste, described only by its notes (never the internal_id).
   c. Ask which position this layer should be: "Would you like this to be your top note, middle note, or base note?" Only offer positions not already assigned to a previous layer in this conversation.
   d. Once they confirm a position for this layer, move to the next container (repeat from 2a) until you've collected the number of containers they asked for in step 1.

3. If, after reaching their target count, the customer asks for even more layers, keep going — ask the same preference question, suggest notes, and ask for a position (if all 3 standard positions are taken, you can note this can be an additional accent to an existing layer).

4. Once all layers are chosen and positioned, summarize the full blend by describing top/middle/base in terms of notes only, and ask for final confirmation, e.g. "Shall I create this custom blend for you?" Also ask if they have a name in mind for their fragrance, or if you should create one for them.

5. Only once the customer confirms "yes" (or similar) to the full summary, call the confirm_scent_combination tool with all confirmed containers and their assigned positions, plus a customName and short description. This is the only place internal_id should ever appear — never in your visible text.

General guidelines:
- Keep replies conversational, warm, and concise (2-4 sentences per turn).
- Never invent notes or containers that aren't in the catalog above.
- Don't skip steps or ask multiple questions at once — one step at a time, in order.`;
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
          items: {
            type: "object",
            properties: {
              internal_id: { type: "string", description: "Exact internal_id (Title) of the note container." },
              position: { type: "string", enum: ["top", "middle", "base"], description: "The fragrance layer this container was assigned to." },
              quantityMl: { type: "number", default: 30, description: "How many ml of this container the customer wants." }
            },
            required: ["internal_id", "position"]
          },
          description: "All confirmed note containers with their assigned positions, minimum 2."
        },
        customName: { type: "string", description: "A unique, creative, personalized name for this fragrance." },
        description: { type: "string", description: "A short, appealing 1-2 sentence product description." }
      },
      required: ["containers", "customName", "description"]
    }
  }
};

// ============================================================
// 5. OPENAI API CALL (with tool-use resolution loop)
// ============================================================
async function callOpenAIOnce(apiKey, messages, useTools) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-nano",
      messages,
      ...(useTools ? { tools: [CONFIRM_COMBINATION_TOOL] } : {})
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("OpenAI API error:", response.status, errText);
    return null;
  }

  return response.json();
}

async function callAI(history) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { replyText: "Configuration error: missing API key.", comboConfirmed: null };
  }

  let messages = [{ role: "system", content: buildSystemPrompt() }, ...history];
  let comboConfirmed = null;
  let confirmedName = null;
  let confirmedDescription = null;
  let finalText = "";

  for (let turn = 0; turn < 3; turn++) {
    const data = await callOpenAIOnce(apiKey, messages, true);
    if (!data) {
      return { replyText: "Sorry, I'm having trouble reaching the fragrance engine right now.", comboConfirmed: null };
    }

    const choice = data.choices[0];
    const message = choice.message;
    const toolCalls = message.tool_calls;

    if (choice.finish_reason === "tool_calls" && toolCalls && toolCalls.length > 0) {
      messages.push({ role: "assistant", content: message.content || null, tool_calls: toolCalls });

      for (const toolCall of toolCalls) {
        if (toolCall.function.name === "confirm_scent_combination") {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            comboConfirmed = args.containers || [];
            confirmedName = args.customName || "Custom Blend";
            confirmedDescription = args.description || "";
          } catch (e) {
            console.error("Failed to parse tool arguments:", e);
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Combination noted internally. Do not call any more tools. Now respond directly to the customer in 2-3 warm sentences confirming their custom blend has been created and is ready."
        });
      }
      continue;
    }

    finalText = message.content || "";
    messages.push({ role: "assistant", content: finalText });
    break;
  }

  if (!finalText) {
    const nudge = [...messages, {
      role: "user",
      content: "Please reply to the customer now in 2-3 warm sentences. Do not call any tools."
    }];
    const data = await callOpenAIOnce(apiKey, nudge, false);
    if (data) {
      finalText = data.choices[0]?.message?.content || "";
      messages.push({ role: "user", content: "Please reply to the customer now in 2-3 warm sentences. Do not call any tools." });
      messages.push({ role: "assistant", content: finalText });
    }
  }

  // Strip the system message before persisting (it's rebuilt fresh each call)
  const persistedMessages = messages.filter(m => m.role !== "system");

  return {
    replyText: finalText || "Great choice! Let's get that crafted for you.",
    comboConfirmed,
    confirmedName,
    confirmedDescription,
    updatedMessages: persistedMessages
  };
}

// ============================================================
// 6. DYNAMIC PRODUCT CREATION
// ============================================================
async function createDynamicProduct(admin, shopDomain, comboConfirmed, customName, description) {
  const FIXED_PRICE = "60.00";
  const FIXED_STOCK = 1;

  if (DATASET_LOAD_ERROR) {
    throw new Error(`Scent catalog is not loaded: ${DATASET_LOAD_ERROR}`);
  }

  const layerDetails = comboConfirmed.map(item => {
    const container = findContainerByInternalId(item.internal_id);
    if (!container) throw new Error(`Container "${item.internal_id}" not found.`);
    return {
      title: item.internal_id,
      notes: container.Notes || "",
      position: item.position,
      quantityMl: item.quantityMl || 30
    };
  });

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
        descriptionHtml: description,
        status: "ACTIVE",
        templateSuffix: "custom-scent",
        metafields: [
          {
            namespace: "custom",
            key: "note_composition",
            type: "json",
            value: JSON.stringify(layerDetails)
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

  const variantsResponse = await admin.graphql(`
    query getVariants($id: ID!) {
      product(id: $id) { variants(first: 1) { edges { node { id inventoryItem { id } } } } }
    }
  `, { variables: { id: product.id } });
  const variantsJson = await variantsResponse.json();
  const variantEdge = variantsJson.data?.product?.variants?.edges?.[0];
  const defaultVariantId = variantEdge?.node?.id;
  const inventoryItemId = variantEdge?.node?.inventoryItem?.id;

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
        variants: [{ id: defaultVariantId, price: FIXED_PRICE }],
      },
    });
  }

  if (inventoryItemId) {
    try {
      const locationsResponse = await admin.graphql(`
        query getPrimaryLocation {
          locations(first: 1) { edges { node { id } } }
        }
      `);
      const locationsJson = await locationsResponse.json();
      const locationId = locationsJson.data?.locations?.edges?.[0]?.node?.id;

      if (locationId) {
        await admin.graphql(`
          mutation setInventory($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              userErrors { field message }
            }
          }
        `, {
          variables: {
            input: {
              name: "available",
              reason: "correction",
              ignoreCompareQuantity: true,
              quantities: [{ inventoryItemId, locationId, quantity: FIXED_STOCK }]
            }
          }
        });
      }
    } catch (invErr) {
      console.error("Failed to set inventory quantity:", invErr);
    }
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
    const originHeader = request.headers.get("Origin") || "";
    let shopDomain = originHeader.replace(/^https?:\/\//, '').split('/')[0];
    if (!shopDomain) {
      shopDomain = "test-3d-products.myshopify.com";
    }

    let admin = null;
    try {
      const result = await unauthenticated.admin(shopDomain);
      admin = result.admin;
      console.log("Successfully verified session credentials for:", shopDomain);
    } catch (authErr) {
      console.error("Admin verification session lookup failure:", authErr.message);
    }

    const body = await request.json();
    const userMessage = body.message || "";
    const { id: conversationId, history } = getConversation(body.conversation_id);

    history.push({ role: "user", content: userMessage });

    const { replyText, comboConfirmed, confirmedName, confirmedDescription, updatedMessages } = await callAI(history);

    CONVERSATIONS.set(conversationId, updatedMessages || history);

    let productResult = null;
    let productError = null;

    if (comboConfirmed && comboConfirmed.length >= 2) {
      console.log("Combo confirmed:", comboConfirmed);
      if (!admin) {
        productError = "Product creation is unavailable right now (session handshake failed).";
        console.error(productError);
      } else {
        try {
          productResult = await createDynamicProduct(admin, shopDomain, comboConfirmed, confirmedName, confirmedDescription);
          console.log("Dynamic product created successfully:", productResult.productUrl);
        } catch (err) {
          productError = err.message;
          console.error("Dynamic product creation failed:", err);
        }
      }
    }

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        send({ type: "id", conversation_id: conversationId });
        send({ type: "chunk", chunk: replyText });

        if (productResult) {
          send({ type: "product_created", url: productResult.productUrl, price: productResult.totalPrice });
        }
        if (productError) {
          send({ type: "product_error", error: productError });
        }

        send({ type: "message_complete" });
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