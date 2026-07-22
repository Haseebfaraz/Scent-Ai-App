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

function tallyClassifications(orders, limit) {
  const tally = {};
  for (const order of orders) {
    const c = (order.classification || "").trim();
    if (!c) continue;
    tally[c] = (tally[c] || 0) + 1;
  }
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

// Northern-hemisphere mapping, matching the US-heavy source data (Michigan, Florida, Puerto Rico,
// etc. in the sample) and the existing weather small talk, which already assumes this convention.
const SEASON_BY_MONTH = ["Winter", "Winter", "Spring", "Spring", "Spring", "Summer", "Summer", "Summer", "Fall", "Fall", "Fall", "Winter"];
function getCurrentSeason() {
  return SEASON_BY_MONTH[new Date().getMonth()];
}

// The raw "Updated Season" column turned out to be inconsistently labeled (verified directly
// against the real DB: "Fall" and "Autumn Months" both exist as distinct values, likewise "Spring
// Months", "Winter Months", "Summer Months", alongside junk like "Not Found"/"#N/A"/"0"/null).
// An exact match on just the clean season name would silently miss the alias-labeled rows.
const SEASON_ALIASES = {
  Winter: ["Winter", "Winter Months"],
  Spring: ["Spring", "Spring Months"],
  Summer: ["Summer", "Summer Months"],
  Fall: ["Fall", "Autumn Months"]
};

// Cascades from whichever level was actually matched down to broader ones (city -> its state ->
// its country, or state -> its country, or country alone) if the more specific sample is too
// small to be meaningful — matches how real fragrance popularity actually varies by region. Tries
// region+CURRENT SEASON first at every level (avoids e.g. recommending heavy oud in summer just
// because it's popular in that region year-round), falling back to region alone if the
// season-narrowed sample is too thin to be meaningful. Returns classification (style) popularity
// alongside notes — both already sit in the DB but were previously unused.
const MIN_SAMPLE_SIZE = 20;
async function getPopularNotesForRegion(region, limit = 8) {
  if (!region) return { notes: [], classifications: [] };
  const { field, value } = region;
  const seasonValues = SEASON_ALIASES[getCurrentSeason()];

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
    attempts = attempts.filter(Boolean);

    for (const where of attempts) {
      const seasonalOrders = await prisma.orderHistory.findMany({
        where: { ...where, season: { in: seasonValues } },
        select: { notes: true, classification: true },
        take: 3000 // cap the scan for performance on a ~937k row table
      });
      if (seasonalOrders.length >= MIN_SAMPLE_SIZE) {
        return { notes: tallyNotes(seasonalOrders, limit), classifications: tallyClassifications(seasonalOrders, 3) };
      }
    }
    for (const where of attempts) {
      const orders = await prisma.orderHistory.findMany({
        where,
        select: { notes: true, classification: true },
        take: 3000
      });
      if (orders.length >= MIN_SAMPLE_SIZE) {
        return { notes: tallyNotes(orders, limit), classifications: tallyClassifications(orders, 3) };
      }
    }
  } catch (err) {
    console.error("Failed to look up regional notes:", err.message);
  }
  return { notes: [], classifications: [] };
}

// The historical-order equivalent of "customers who bought X also had Y in their blend" — used to
// bias search_containers_for_layer toward combinations with real, proven success in the order
// history, rather than just a plain keyword match. Deliberately a soft ranking signal, not a hard
// filter — a note with no historical co-occurrence data yet should never become unsuggestable.
async function getCoOccurringNotes(noteWord, limit = 10) {
  if (!noteWord) return [];
  try {
    const orders = await prisma.orderHistory.findMany({
      where: { notes: { contains: noteWord } },
      select: { notes: true },
      take: 2000
    });
    const tally = {};
    const targetLower = noteWord.toLowerCase();
    for (const order of orders) {
      const notes = order.notes.split(",").map(n => n.trim()).filter(Boolean);
      for (const note of notes) {
        if (note.toLowerCase().includes(targetLower)) continue;
        tally[note] = (tally[note] || 0) + 1;
      }
    }
    return Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name]) => name);
  } catch (err) {
    console.error("Failed to look up co-occurring notes:", err.message);
    return [];
  }
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
// The step-by-step scripted flow and its validation gate chain (name/location/email checks,
// draft-pitch checks, position-distribution checks, etc.) were deliberately discarded here to make
// room for a new conversation design — see the "Backup checkpoint before rewriting the chat flow
// from scratch" commit for the full previous version if anything needs to be recovered from it.
async function buildSystemPrompt(history, knownCustomerEmail) {
  const catalogLines = buildRelevantCatalogSlice(history).map(c =>
    `- [internal_id: ${c.Title || "Untitled"}] Notes: ${c.Notes || "no notes listed"}`
  ).join("\n");

  const regionMaps = await getRegionMaps();
  const regionCandidate = extractRegionFromHistory(history, regionMaps);
  const { notes: regionalNotes, classifications: regionalClassifications } = await getPopularNotesForRegion(regionCandidate);
  const currentSeason = getCurrentSeason();
  const classificationClause = regionalClassifications.length > 0
    ? `, often leaning toward ${regionalClassifications.join(" or ")}-style fragrances`
    : "";
  const regionalNotesLine = regionalNotes.length > 0
    ? `\nReal past customers from this same region during ${currentSeason} have shown a taste for these notes: ${regionalNotes.join(", ")}${classificationClause}.\n`
    : "";
  const emailAlreadyKnown = Boolean(knownCustomerEmail);

  return `You are Scent Architect AI, the voice of a real, experienced boutique perfumer — warm, observant, a little playful, genuinely curious about each customer. You help customers build a personalized fragrance by combining note containers into layers (top, middle, base), described only by their scent notes and character — never by internal product names.
The current season is ${currentSeason}.
${regionalNotesLine}
Internal catalog (for your reference only — see rules below on how to talk about these):
${catalogLines}

How the conversation actually flows (natural, not a script — read the room and adapt):

1. Your very first message (before the customer has said anything fragrance-related) is warm, in-character small talk — react to whatever they actually just said, don't just recite a script. Once that's flowed a beat, introduce yourself briefly and ask for their name in return — reciprocity, not an interrogation ("I'm here to help craft something just for you — who am I chatting with today?"). Wait for their answer. THEN, once you have their name, ask where they're based as its own separate question — wait for that answer too, and only then riff naturally on the real season/weather for their location given above. Every beat should acknowledge what they just said before moving on — never bundle multiple questions into one message; that reads as a form, not a conversation.

2. Once that's flowed naturally, get genuinely curious about their actual life — ask what a typical day looks like for them (work, routine, what they're usually doing, what occasions they need this fragrance for), and have a REAL back-and-forth about it: ask a natural follow-up or two, react to specifics they mention, don't just check a box and move on. Only once that's had real substance, ask what kind of scent they're drawn to, in their own words — offer a few evocative example directions if it helps them articulate it (clean & minimal, rich & woody, bright & aquatic, warm & spicy, soft & floral, cozy & gourmand), but let THEM describe it, never a rigid multiple-choice quiz. If their answer is vague or one-word, don't move on yet — ask what that means to them, or what they don't like, until you actually have something specific to work with. If they volunteer personal or family context while explaining their taste (e.g. "my grandfather always wore vetiver," "we always leaned toward subtle scents"), warmly acknowledge it in the moment and let any specific notes they mention inform the blend — but never ask about their background, age, gender, or ethnicity directly, and never treat any of that as a factor you're tracking or looking anything up by. The customer's own stated style words, their real lifestyle/occasion, and their real location/season are the entire basis for what you recommend.

3. Only once you've had a genuinely substantial conversation — their lifestyle with real detail, AND their own stated style preference clearly articulated, not just a single vague exchange — CALL search_containers_for_layer for each distinct direction they've expressed. Rushing to search after only one or two short exchanges skips the part of the conversation that actually makes the recommendation feel personal — take the time first. Never invent or blend a note combination from memory — only ever use what the tool actually returns. From the real results, put together ONE complete draft blend (2-4 different containers, each assigned top/middle/base — a 4th container doubles into middle or base, never top) and present it all at once as a finished, named recommendation, the way a real perfumer would — give the blend a creative name, and narrate it warmly: what's on top, what's in the heart, what anchors the base, and briefly why each fits what they told you (their lifestyle, their stated style, the season). State every note exactly as the tool returned it — real note names, verbatim, never invented, never adjectives standing in for real notes.

4. If (and only if) the customer asks follow-up questions about specific notes — their character, whether something leans sweet or green, how long it'll last, how it projects — answer genuinely and specifically, like someone who actually knows perfumery, the way you'd reassure a customer that "violet leaf here is green and watery, not a sweet floral" or that a heavier base note is what gives it staying power. Don't invent which notes are in the blend, but real descriptive/technical knowledge about a note's character is fine to share.

5. Once they're happy, ask if they have a name in mind for the fragrance (or want you to come up with one)${emailAlreadyKnown ? "" : ", and get their email so you can save this build under it"}. ${emailAlreadyKnown ? "Their email is already on file — don't ask for it again." : ""} Then call confirm_scent_combination with the confirmed containers/positions, the fragrance's own name, a short warm description, the customer's real name, and their email.

Rules:
- NEVER say, mention, or hint at the "internal_id" value (the container's title) in your conversational replies to the customer. Only describe containers by their real scent notes.
- When you call confirm_scent_combination, every internal_id must be copied EXACTLY from a "[internal_id: ...]" bracket in the catalog above — never a note name, never invented.
- Each layer must use a DIFFERENT container.
- Copy note names verbatim from the catalog when describing them to the customer — never paraphrase or invent a "poetic" version.
- Keep replies warm and conversational — a real back-and-forth, not clinical, but don't ramble; let the customer drive the pace.`;
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
// can present are mechanically constrained to what a real search actually returns.
const SEARCH_CONTAINERS_TOOL = {
  type: "function",
  function: {
    name: "search_containers_for_layer",
    description: "Search the REAL catalog for containers matching a scent direction or specific note the customer mentioned (e.g. 'woody', 'marshmallow', 'orange'). Returns real containers with their actual notes, copied straight from the catalog — never invent, blend, or guess at notes from memory; only ever present what this tool actually returns.",
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
      ...(useTools ? { tools: [CONFIRM_COMBINATION_TOOL, SEARCH_CONTAINERS_TOOL] } : {})
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("OpenAI API error:", response.status, errText);
    return null;
  }

  return response.json();
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

// knownCustomerEmail comes from the storefront itself — either the customer's real Shopify
// account login (native `customer.email`, no OAuth flow needed) or the login-gate popup shown
// when they're not logged in — and is trusted the same as an email extracted from their own chat
// messages, since it originates the same way: something the customer actually provided, not a
// model guess.
async function callAI(history, conversationId, knownCustomerEmail) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { replyText: "Configuration error: missing API key.", comboConfirmed: null };
  }

  let messages = [{ role: "system", content: await buildSystemPrompt(history, knownCustomerEmail) }, ...history];
  let comboConfirmed = null;
  let confirmedName = null;
  let confirmedDescription = null;
  let confirmedCustomerNotes = null;
  let confirmedCustomerName = null;
  let confirmedCustomerEmail = null;
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
        let toolResultContent = "Combination noted internally. Now respond directly to the customer in 2-3 warm sentences confirming their custom blend has been created and is ready.";

        if (toolCall.function.name === "confirm_scent_combination") {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const containers = args.containers || [];

            // The only hard requirement kept from the old gate chain: never create a product
            // without a real name and real location actually present in the customer's OWN
            // messages — not just whatever the model happened to fill into the tool call args.
            const customerText = history
              .filter(m => m.role === "user" && typeof m.content === "string")
              .map(m => m.content)
              .join(" ")
              .toLowerCase();
            const nameWords = (args.customerName || "").toLowerCase().split(/\s+/).filter(w => w.length > 1);
            const hasRealName = nameWords.length > 0 && nameWords.some(w => new RegExp(`\\b${w}\\b`).test(customerText));

            const regionMaps = await getRegionMaps();
            const hasRealLocation = Boolean(extractRegionFromHistory(history, regionMaps));

            if (!hasRealName) {
              toolResultContent = `Error: no real customer name was found anywhere in their own messages — "${args.customerName}" looks guessed rather than actually given. Do NOT create the product yet. Ask the customer plainly for their name, wait for their real reply, then try again.`;
            } else if (!hasRealLocation) {
              toolResultContent = `Error: no real location was found anywhere in the customer's own messages. Do NOT create the product yet. Ask the customer where they're based, wait for their real reply, then try again.`;
            } else {
              comboConfirmed = containers;
              confirmedName = args.customName || "Custom Blend";
              confirmedDescription = args.description || "";
              confirmedCustomerNotes = args.customerNotes || "";
              confirmedCustomerName = args.customerName || "";
              confirmedCustomerEmail = knownCustomerEmail || extractEmailFromHistory(history) || args.customerEmail || "";
            }
          } catch (e) {
            console.error("Failed to parse confirm_scent_combination arguments:", e);
            toolResultContent = "Error: couldn't parse those tool call arguments — call confirm_scent_combination again with valid JSON.";
          }
        } else if (toolCall.function.name === "search_containers_for_layer") {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const query = args.query || "";
            const candidates = scoreContainersFor(query).slice(0, 8);

            // Two real, independent historical signals feed the ranking bonus — neither is a hard
            // filter, both just push proven-successful real containers higher:
            // (1) notes that historically got bought ALONGSIDE this query term, across ~937k orders.
            const coOccurring = (await getCoOccurringNotes(query, 10)).map(n => n.toLowerCase());
            // (2) notes popular with real customers from THIS customer's own region during the
            // current season — the actual location/season they gave us in Phase 1, not a guess.
            const regionMaps = await getRegionMaps();
            const regionCandidate = extractRegionFromHistory(history, regionMaps);
            const { notes: regionalNotes } = await getPopularNotesForRegion(regionCandidate);
            const regionalLower = regionalNotes.map(n => n.toLowerCase());

            const bonus = (c) => {
              const notesLower = (c.Notes || "").toLowerCase();
              const coScore = coOccurring.filter(n => notesLower.includes(n)).length;
              const regionScore = regionalLower.filter(n => notesLower.includes(n)).length;
              return coScore + regionScore;
            };
            const hasSignal = coOccurring.length > 0 || regionalLower.length > 0;
            const matches = hasSignal
              ? [...candidates].sort((a, b) => bonus(b) - bonus(a)).slice(0, 4)
              : candidates.slice(0, 4);
            toolResultContent = matches.length === 0
              ? `No real containers matched "${query}". Tell the customer plainly those exact notes aren't available right now, and try a related term instead of inventing notes.`
              : `Real containers found for "${query}":\n${matches.map(c => `- [internal_id: ${c.Title}] Notes: ${c.Notes}`).join("\n")}\n\nPresent a few of these to the customer using their real notes — never mention "internal_id" or any container's title.`;
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
      continue;
    }

    finalText = message.content || "";
    messages.push({ role: "assistant", content: finalText });
    break;
  }

  // Strip the system message before persisting (it's rebuilt fresh each call)
  const persistedMessages = messages.filter(m => m.role !== "system");

  return {
    replyText: finalText || "Great choice! Let's get that crafted for you.",
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

  if (DATASET_LOAD_ERROR) {
    throw new Error(`Scent catalog is not loaded: ${DATASET_LOAD_ERROR}`);
  }

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

    // Provided by the storefront widget — either the customer's real logged-in account email
    // (native Shopify login, no OAuth needed) or what they entered in the login-gate popup shown
    // when not logged in. Trusted the same as an email the customer typed in chat.
    const knownCustomerEmail = typeof body.customer_email === "string" && body.customer_email.includes("@")
      ? body.customer_email.trim()
      : null;

    const { replyText, comboConfirmed, confirmedName, confirmedDescription, confirmedCustomerNotes, confirmedCustomerName, confirmedCustomerEmail, updatedMessages } = await callAI(history, conversationId, knownCustomerEmail);

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