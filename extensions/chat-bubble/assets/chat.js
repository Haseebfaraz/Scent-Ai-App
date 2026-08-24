/**
 * Shop AI Chat - Client-side implementation
 *
 * This module handles the chat interface for the Shopify AI Chat application.
 * It manages the UI interactions, API communication, and message rendering.
 */
(function() {
  'use strict';

  /**
   * Single source of truth for the backend origin every fetch() targets. Strips trailing
   * slashes so a theme-setting value saved as ".../onrender.com/" doesn't produce
   * ".../onrender.com//chat" (the double slash 404s on the backend).
   * @returns {string}
   */
  function getApiBaseUrl() {
    return String(window.appBaseUrl || 'https://localhost:3458').replace(/\/+$/, '');
  }

  /**
   * Application namespace to prevent global scope pollution
   */
  const ShopAIChat = {
    // Real, verified Shopify account info — set directly from window globals the Liquid block
    // only ever renders inside its {% if customer %} branch (see chat-interface.liquid). There's
    // no client-side gate here anymore: an unauthenticated visitor never receives chat.js's
    // markup or this script at all, so by the time this file runs, login is already guaranteed.
    customerEmail: null,
    customerName: null,

    /**
     * Single letter shown in the user message avatar — prefers their real name, falls back to
     * email, falls back to a generic mark only in the brief window before either is set.
     */
    getUserInitial: function() {
      const source = this.customerName || this.customerEmail;
      return source ? source.trim().charAt(0).toUpperCase() : '•';
    },

    /**
     * UI-related elements and functionality
     */
    UI: {
      elements: {},
      isMobile: false,

      /**
       * Initialize UI elements and event listeners
       * @param {HTMLElement} container - The main container element
       */
      init: function(container) {
        if (!container) return;

        // Cache DOM elements
        this.elements = {
          container: container,
          chatBubble: container.querySelector('.shop-ai-chat-bubble'),
          chatWindow: container.querySelector('.shop-ai-chat-window'),
          closeButton: container.querySelector('.shop-ai-chat-close'),
          chatInput: container.querySelector('.shop-ai-chat-input input'),
          sendButton: container.querySelector('.shop-ai-chat-send'),
          messagesContainer: container.querySelector('.shop-ai-chat-messages')
        };

        // Detect mobile device
        this.isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

        // Set up event listeners
        this.setupEventListeners();

        // Fix for iOS Safari viewport height issues
        if (this.isMobile) {
          this.setupMobileViewport();
        }
      },

      /**
       * Set up all event listeners for UI interactions
       */
      setupEventListeners: function() {
        const { chatBubble, closeButton, chatInput, sendButton, messagesContainer } = this.elements;

        // Toggle chat window visibility
        chatBubble.addEventListener('click', () => this.toggleChatWindow());

        // Close chat window
        closeButton.addEventListener('click', () => this.closeChatWindow());

        // Send message when pressing Enter in input
        chatInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter' && chatInput.value.trim() !== '') {
            ShopAIChat.Message.send(chatInput, messagesContainer);

            // On mobile, handle keyboard
            if (this.isMobile) {
              chatInput.blur();
              setTimeout(() => chatInput.focus(), 300);
            }
          }
        });

        // Send message when clicking send button
        sendButton.addEventListener('click', () => {
          if (chatInput.value.trim() !== '') {
            ShopAIChat.Message.send(chatInput, messagesContainer);

            // On mobile, focus input after sending
            if (this.isMobile) {
              setTimeout(() => chatInput.focus(), 300);
            }
          }
        });

        // Handle window resize to adjust scrolling
        window.addEventListener('resize', () => this.scrollToBottom());
      },

      /**
       * Setup mobile-specific viewport adjustments
       */
      setupMobileViewport: function() {
        const setViewportHeight = () => {
          document.documentElement.style.setProperty('--viewport-height', `${window.innerHeight}px`);
        };
        window.addEventListener('resize', setViewportHeight);
        setViewportHeight();
      },

      /**
       * Toggle chat window visibility
       */
      toggleChatWindow: function() {
        const { chatWindow, chatInput } = this.elements;

        chatWindow.classList.toggle('active');

        if (chatWindow.classList.contains('active')) {
          // On mobile, prevent body scrolling and delay focus
          if (this.isMobile) {
            document.body.classList.add('shop-ai-chat-open');
            setTimeout(() => chatInput.focus(), 500);
          } else {
            chatInput.focus();
          }
          // Always scroll messages to bottom when opening
          this.scrollToBottom();
        } else {
          // Remove body class when closing
          document.body.classList.remove('shop-ai-chat-open');
        }
      },

      /**
       * Close chat window
       */
      closeChatWindow: function() {
        const { chatWindow, chatInput } = this.elements;

        chatWindow.classList.remove('active');

        // On mobile, blur input to hide keyboard and enable body scrolling
        if (this.isMobile) {
          chatInput.blur();
          document.body.classList.remove('shop-ai-chat-open');
        }
      },

      /**
       * Scroll messages container to bottom
       */
      scrollToBottom: function() {
        const { messagesContainer } = this.elements;
        setTimeout(() => {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }, 100);
      },

      /**
       * Show typing indicator in the chat
       */
      showTypingIndicator: function() {
        const { messagesContainer } = this.elements;

        const typingIndicator = document.createElement('div');
        typingIndicator.classList.add('shop-ai-typing-indicator');
        typingIndicator.innerHTML = '<span></span><span></span><span></span>';
        messagesContainer.appendChild(typingIndicator);
        this.scrollToBottom();
      },

      /**
       * Remove typing indicator from the chat
       */
      removeTypingIndicator: function() {
        const { messagesContainer } = this.elements;

        const typingIndicator = messagesContainer.querySelector('.shop-ai-typing-indicator');
        if (typingIndicator) {
          typingIndicator.remove();
        }
      },

      // Cycled while the full-screen creation overlay is up — order matches the visual fill
      // sequence below (top band, then middle, then base, then a finishing glow across all three).
      PRODUCT_OVERLAY_STATUS_PHASES: [
        'Infusing Top Notes…',
        'Blending Heart Notes…',
        'Fixing Base Notes…',
        'Finalizing your custom blend…'
      ],
      PRODUCT_OVERLAY_PHASE_MS: 2000, // 4 phases x 2s = one 8s loop, matching the CSS animation-duration below

      /**
       * Show a full-screen immersive overlay (not an inline chat message) while a custom product
       * is actually being created via the Admin API — appended to <body>, not the messages list,
       * so it dims the entire storefront (including the chat widget itself) behind it. Loops
       * indefinitely since real product-creation timing varies; removeProductCreatingAnimation()
       * stops it once the "product_created"/"product_error" SSE event actually arrives.
       */
      showProductCreatingAnimation: function() {
        if (document.querySelector('.shop-ai-product-overlay')) return;

        const overlay = document.createElement('div');
        overlay.classList.add('shop-ai-product-overlay');
        overlay.innerHTML = `
          <div class="shop-ai-product-overlay-bottle">
            <svg viewBox="0 0 120 200">
              <defs>
                <linearGradient id="shopAiFluidTop" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0%" stop-color="#c7d94a"/>
                  <stop offset="100%" stop-color="#f2e07a"/>
                </linearGradient>
                <linearGradient id="shopAiFluidMiddle" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0%" stop-color="#c9832c"/>
                  <stop offset="100%" stop-color="#e08fa0"/>
                </linearGradient>
                <linearGradient id="shopAiFluidBase" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0%" stop-color="#4a2f1c"/>
                  <stop offset="100%" stop-color="#8c5a34"/>
                </linearGradient>
                <clipPath id="shopAiBottleClip">
                  <rect x="15" y="35" width="90" height="150" rx="18"/>
                </clipPath>
              </defs>
              <rect x="45" y="0" width="30" height="14" rx="4" fill="#2e2a24"/>
              <rect x="50" y="10" width="20" height="25" fill="#2e2a24" opacity="0.6"/>
              <g class="shop-ai-fluid-group" clip-path="url(#shopAiBottleClip)">
                <!-- Three real, non-overlapping bands (top/middle/base thirds of the bottle),
                     each scaling in independently from its own bottom edge — a true sequential
                     reveal, not one gradient rect standing in for three layers. -->
                <rect class="shop-ai-fluid-band shop-ai-fluid-top" x="15" y="35" width="90" height="50" fill="url(#shopAiFluidTop)"/>
                <rect class="shop-ai-fluid-band shop-ai-fluid-middle" x="15" y="85" width="90" height="50" fill="url(#shopAiFluidMiddle)"/>
                <rect class="shop-ai-fluid-band shop-ai-fluid-base" x="15" y="135" width="90" height="50" fill="url(#shopAiFluidBase)"/>
              </g>
              <rect x="15" y="35" width="90" height="150" rx="18" fill="none" stroke="#57534e" stroke-width="3"/>
            </svg>
          </div>
          <p class="shop-ai-product-overlay-status"></p>
        `;
        document.body.appendChild(overlay);
        // Prevents the dimmed storefront from scrolling behind the overlay while it's up.
        document.body.classList.add('shop-ai-overlay-open');
        // Force a layout pass before adding is-visible so the opacity transition actually
        // animates in, instead of the overlay just snapping straight to fully visible.
        requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('is-visible')));

        const statusEl = overlay.querySelector('.shop-ai-product-overlay-status');
        const phases = this.PRODUCT_OVERLAY_STATUS_PHASES;
        let phaseIndex = 0;
        const advancePhase = () => {
          statusEl.textContent = phases[phaseIndex % phases.length];
          phaseIndex++;
        };
        advancePhase();
        this._productOverlayInterval = setInterval(advancePhase, this.PRODUCT_OVERLAY_PHASE_MS);
        this._productOverlayEl = overlay;
      },

      /**
       * Same full-screen bottle overlay as showProductCreatingAnimation, but for the preview_ready
       * redirect — a single fixed message, no phase-cycling (nothing is actually being created
       * here, so "Infusing Top Notes…" et al. would be misleading), just enough to cover the brief
       * gap before the new page finishes loading instead of an abrupt blank flash.
       */
      showPreviewOpeningAnimation: function() {
        this.showProductCreatingAnimation();
        if (this._productOverlayInterval) {
          clearInterval(this._productOverlayInterval);
          this._productOverlayInterval = null;
        }
        const statusEl = this._productOverlayEl && this._productOverlayEl.querySelector('.shop-ai-product-overlay-status');
        if (statusEl) statusEl.textContent = 'Opening your fragrance preview…';
      },

      /**
       * Fade out and remove the full-screen creation overlay once the API call actually resolves
       * (success or error) — never yanked away instantly, so the transition reads as deliberate.
       */
      removeProductCreatingAnimation: function() {
        const overlay = this._productOverlayEl || document.querySelector('.shop-ai-product-overlay');
        if (!overlay) return;

        clearInterval(this._productOverlayInterval);
        this._productOverlayInterval = null;
        this._productOverlayEl = null;

        overlay.classList.remove('is-visible');
        document.body.classList.remove('shop-ai-overlay-open');
        // Matches the CSS opacity transition duration — only detach the node once it's actually
        // finished fading, not before.
        setTimeout(() => overlay.remove(), 500);
      },

      /**
       * Display product results in the chat
       * @param {Array} products - Array of product data objects
       */
      displayProductResults: function(products) {
        const { messagesContainer } = this.elements;

        // Create a wrapper for the product section
        const productSection = document.createElement('div');
        productSection.classList.add('shop-ai-product-section');
        messagesContainer.appendChild(productSection);

        // Add a header for the product results
        const header = document.createElement('div');
        header.classList.add('shop-ai-product-header');
        header.innerHTML = '<h4>Top Matching Products</h4>';
        productSection.appendChild(header);

        // Create the product grid container
        const productsContainer = document.createElement('div');
        productsContainer.classList.add('shop-ai-product-grid');
        productSection.appendChild(productsContainer);

        if (!products || !Array.isArray(products) || products.length === 0) {
          const noProductsMessage = document.createElement('p');
          noProductsMessage.textContent = "No products found";
          noProductsMessage.style.padding = "10px";
          productsContainer.appendChild(noProductsMessage);
        } else {
          products.forEach(product => {
            const productCard = ShopAIChat.Product.createCard(product);
            productsContainer.appendChild(productCard);
          });
        }

        this.scrollToBottom();
      },

      /**
       * Render generate_new_product_combinations / refine_combination_recommendations results as
       * cards (Phase 14) — rank, real product titles, type, key notes, why it works, ratio,
       * confidence, existing/new badge, risk warning, and action buttons. Purely a render of what
       * the backend already computed; never reformats or re-derives any of the numbers itself.
       * @param {Array} combinations - ProposedCombination[] (each carries its own recommendationId).
       */
      displayCombinationRecommendations: function(combinations) {
        const { messagesContainer } = this.elements;

        const section = document.createElement('div');
        section.classList.add('shop-ai-combo-section');
        messagesContainer.appendChild(section);

        const header = document.createElement('div');
        header.classList.add('shop-ai-combo-header');
        header.innerHTML = '<h4>Recommended Combinations</h4>';
        section.appendChild(header);

        const grid = document.createElement('div');
        grid.classList.add('shop-ai-combo-grid');
        section.appendChild(grid);

        if (!combinations || !Array.isArray(combinations) || combinations.length === 0) {
          const empty = document.createElement('p');
          empty.textContent = 'No new combinations available right now.';
          empty.style.padding = '10px';
          grid.appendChild(empty);
        } else {
          combinations.forEach((combo, index) => {
            grid.appendChild(ShopAIChat.Combination.createCard(combo, index + 1));
          });
        }

        this.scrollToBottom();
      }
    },

    /**
     * Message handling and display functionality
     */
    Message: {
      /**
       * Send a message to the API
       * @param {HTMLInputElement} chatInput - The input element
       * @param {HTMLElement} messagesContainer - The messages container
       */
      send: async function(chatInput, messagesContainer) {
        const userMessage = chatInput.value.trim();
        const conversationId = sessionStorage.getItem('shopAiConversationId');

        // Fix (static frontend greeting invisible to the backend) — the welcome message shown
        // before the customer's first reply is purely client-side and was never part of what the
        // model sees, so it had no idea a greeting (possibly asking about their day) already
        // happened — it would either ask it again or misread the customer's first reply as
        // answering something else. Sent once, only on a brand-new conversation, then cleared so
        // it's never resent on a later turn (see the matching fix in chat.jsx's action()).
        const pendingGreeting = !conversationId ? sessionStorage.getItem('shopAiPendingGreeting') : null;
        sessionStorage.removeItem('shopAiPendingGreeting');

        // Add user message to chat
        this.add(userMessage, 'user', messagesContainer);

        // Clear input
        chatInput.value = '';

        // Show typing indicator
        ShopAIChat.UI.showTypingIndicator();

        try {
          ShopAIChat.API.streamResponse(userMessage, conversationId, messagesContainer, pendingGreeting);
        } catch (error) {
          console.error('Error communicating with Claude API:', error);
          ShopAIChat.UI.removeTypingIndicator();
          this.add("Sorry, I couldn't process your request at the moment. Please try again later.", 'assistant', messagesContainer);
        }
      },

      /**
       * Add a message to the chat
       * @param {string} text - Message content
       * @param {string} sender - Message sender ('user' or 'assistant')
       * @param {HTMLElement} messagesContainer - The messages container
       * @returns {HTMLElement} The created message element
       */
      add: function(text, sender, messagesContainer) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('shop-ai-message', sender);

        if (sender === 'assistant') {
          messageElement.dataset.rawText = text;
          ShopAIChat.Formatting.formatMessageContent(messageElement);
        } else {
          messageElement.textContent = text;
          messageElement.dataset.initial = ShopAIChat.getUserInitial();
        }

        messagesContainer.appendChild(messageElement);
        ShopAIChat.UI.scrollToBottom();

        return messageElement;
      },

      /**
       * Add a tool use message to the chat with expandable arguments
       * @param {string} toolMessage - Tool use message content
       * @param {HTMLElement} messagesContainer - The messages container
       */
      addToolUse: function(toolMessage, messagesContainer) {
        // Parse the tool message to extract tool name and arguments
        const match = toolMessage.match(/Calling tool: (\w+) with arguments: (.+)/);
        if (!match) {
          // Fallback for unexpected format
          const toolUseElement = document.createElement('div');
          toolUseElement.classList.add('shop-ai-message', 'tool-use');
          toolUseElement.textContent = toolMessage;
          messagesContainer.appendChild(toolUseElement);
          ShopAIChat.UI.scrollToBottom();
          return;
        }

        const toolName = match[1];
        const argsString = match[2];

        // Create the main tool use element
        const toolUseElement = document.createElement('div');
        toolUseElement.classList.add('shop-ai-message', 'tool-use');

        // Create the header (always visible)
        const headerElement = document.createElement('div');
        headerElement.classList.add('shop-ai-tool-header');

        const toolText = document.createElement('span');
        toolText.classList.add('shop-ai-tool-text');
        toolText.textContent = `Calling tool: ${toolName}`;

        const toggleElement = document.createElement('span');
        toggleElement.classList.add('shop-ai-tool-toggle');
        toggleElement.textContent = '[+]';

        headerElement.appendChild(toolText);
        headerElement.appendChild(toggleElement);

        // Create the arguments section (initially hidden)
        const argsElement = document.createElement('div');
        argsElement.classList.add('shop-ai-tool-args');

        try {
          // Try to format JSON arguments nicely
          const parsedArgs = JSON.parse(argsString);
          argsElement.textContent = JSON.stringify(parsedArgs, null, 2);
        } catch (e) {
          // If not valid JSON, just show as-is
          argsElement.textContent = argsString;
        }

        // Add click handler to toggle arguments visibility
        headerElement.addEventListener('click', function() {
          const isExpanded = argsElement.classList.contains('expanded');
          if (isExpanded) {
            argsElement.classList.remove('expanded');
            toggleElement.textContent = '[+]';
          } else {
            argsElement.classList.add('expanded');
            toggleElement.textContent = '[-]';
          }
        });

        // Assemble the complete element
        toolUseElement.appendChild(headerElement);
        toolUseElement.appendChild(argsElement);

        messagesContainer.appendChild(toolUseElement);
        ShopAIChat.UI.scrollToBottom();
      }
    },

    /**
     * Text formatting and markdown handling
     */
    Formatting: {
      /**
       * Format message content with markdown and links
       * @param {HTMLElement} element - The element to format
       */
      formatMessageContent: function(element) {
        if (!element || !element.dataset.rawText) return;

        const rawText = element.dataset.rawText;

        // Process the text with various Markdown features
        let processedText = rawText;

        // Process Markdown links
        const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
        processedText = processedText.replace(markdownLinkRegex, (match, text, url) => {
          // If it's a checkout link, replace the text
          if (url.includes('/cart') || url.includes('checkout')) {
            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">click here to proceed to checkout</a>';
          } else {
            // For normal links, preserve the original text
            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
          }
        });

        // Convert text to HTML with proper list handling
        processedText = this.convertMarkdownToHtml(processedText);

        // Apply the formatted HTML
        element.innerHTML = processedText;
      },

      /**
       * Convert Markdown text to HTML with list support
       * @param {string} text - Markdown text to convert
       * @returns {string} HTML content
       */
      convertMarkdownToHtml: function(text) {
        text = text.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>');
        const lines = text.split('\n');
        let currentList = null;
        let listItems = [];
        let htmlContent = '';
        let startNumber = 1;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const unorderedMatch = line.match(/^\s*([-*])\s+(.*)/);
          const orderedMatch = line.match(/^\s*(\d+)[\.)]\s+(.*)/);

          if (unorderedMatch) {
            if (currentList !== 'ul') {
              if (currentList === 'ol') {
                htmlContent += `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
                listItems = [];
              }
              currentList = 'ul';
            }
            listItems.push('<li>' + unorderedMatch[2] + '</li>');
          } else if (orderedMatch) {
            if (currentList !== 'ol') {
              if (currentList === 'ul') {
                htmlContent += '<ul>' + listItems.join('') + '</ul>';
                listItems = [];
              }
              currentList = 'ol';
              startNumber = parseInt(orderedMatch[1], 10);
            }
            listItems.push('<li>' + orderedMatch[2] + '</li>');
          } else {
            if (currentList) {
              htmlContent += currentList === 'ul'
                ? '<ul>' + listItems.join('') + '</ul>'
                : `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
              listItems = [];
              currentList = null;
            }

            if (line.trim() === '') {
              htmlContent += '<br>';
            } else {
              htmlContent += '<p>' + line + '</p>';
            }
          }
        }

        if (currentList) {
          htmlContent += currentList === 'ul'
            ? '<ul>' + listItems.join('') + '</ul>'
            : `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
        }

        htmlContent = htmlContent.replace(/<\/p><p>/g, '</p>\n<p>');
        return htmlContent;
      }
    },

    /**
     * API communication and data handling
     */
    API: {
      /**
       * Stream a response from the API
       * @param {string} userMessage - User's message text
       * @param {string} conversationId - Conversation ID for context
       * @param {HTMLElement} messagesContainer - The messages container
       */
      streamResponse: async function(userMessage, conversationId, messagesContainer, greeting) {
        let currentMessageElement = null;

        try {
          const promptType = window.shopChatConfig?.promptType || "standardAssistant";
          const requestBody = JSON.stringify({
            message: userMessage,
            conversation_id: conversationId,
            prompt_type: promptType,
            shop_domain: window.shopDomain,
            customer_email: ShopAIChat.customerEmail || null,
            customer_name: ShopAIChat.customerName || null,
            greeting: greeting || null
          });

          const streamUrl = getApiBaseUrl() + '/chat';
          const shopId = window.shopId;

          const response = await fetch(streamUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'X-Shopify-Shop-Id': shopId,
              // Skips ngrok's browser-warning interstitial page when the tunnel is a free
              // ngrok URL — without this, ngrok intercepts the request before it ever reaches
              // the app, and this fetch gets an HTML warning page back instead of the stream.
              'ngrok-skip-browser-warning': 'true'
            },
            body: requestBody
          });

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          // Create initial message element
          let messageElement = document.createElement('div');
          messageElement.classList.add('shop-ai-message', 'assistant');
          messageElement.textContent = '';
          messageElement.dataset.rawText = '';
          messagesContainer.appendChild(messageElement);
          currentMessageElement = messageElement;

          // Process the stream
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  this.handleStreamEvent(data, currentMessageElement, messagesContainer, userMessage,
                    (newElement) => { currentMessageElement = newElement; });
                } catch (e) {
                  console.error('Error parsing event data:', e, line);
                }
              }
            }
          }
        } catch (error) {
          console.error('Error in streaming:', error);
          ShopAIChat.UI.removeTypingIndicator();
          ShopAIChat.Message.add("Sorry, I couldn't process your request. Please try again later.",
            'assistant', messagesContainer);
        }
      },

      /**
       * Fix 4 (auto-preview flow) — one reusable handler for the preview_ready event, so it's
       * detected the same way no matter which response mode it arrives through. Fix (absolute
       * preview URL) — the backend now always sends previewUrl as a full absolute URL (this app's
       * own Render domain, built via app/utils/previewUrl.server.js), since the widget runs on the
       * Shopify STOREFRONT domain — prepending window.appBaseUrl (or anything else) to an already-
       * absolute URL would be wrong, so this never does that; it navigates to event.previewUrl
       * exactly as given, after confirming it really is a well-formed URL.
       * @param {Object} event - a parsed event object, expected shape {type: "preview_ready", previewUrl}.
       * @returns {boolean} true if this was a preview_ready event and navigation was started.
       */
      handlePreviewReady: function(event) {
        if (!event || event.type !== 'preview_ready') return false;
        if (!event.previewUrl) return false;

        let target;
        try {
          target = new URL(event.previewUrl);
        } catch (e) {
          console.error('Invalid preview URL', event.previewUrl);
          return false;
        }

        console.info('PREVIEW_READY_RECEIVED_BY_WIDGET', {
          recommendationId: event.recommendationId || null,
          previewUrl: target.toString()
        });
        ShopAIChat.UI.removeTypingIndicator();
        ShopAIChat.UI.showPreviewOpeningAnimation();

        console.info('PREVIEW_REDIRECT_STARTED', { previewUrl: target.toString() });
        window.location.assign(target.toString());
        return true;
      },

      /**
       * Handle stream events from the API
       * @param {Object} data - Event data
       * @param {HTMLElement} currentMessageElement - Current message element being updated
       * @param {HTMLElement} messagesContainer - The messages container
       * @param {string} userMessage - The original user message
       * @param {Function} updateCurrentElement - Callback to update the current element reference
       */
      handleStreamEvent: function(data, currentMessageElement, messagesContainer, userMessage, updateCurrentElement) {
        // Checked before the switch, not as one case among many — Fix 4 requires detecting
        // preview_ready "regardless of whether the server response is standard JSON, streaming,
        // SSE, NDJSON, a tool-event payload, or the final accumulated response object." A
        // top-of-function check here means it fires the same way even if a future response mode
        // wraps or duplicates the object being switched on below.
        if (this.handlePreviewReady(data)) return;

        switch (data.type) {
          case 'id':
            if (data.conversation_id) {
              sessionStorage.setItem('shopAiConversationId', data.conversation_id);
            }
            break;

          case 'chunk':
            ShopAIChat.UI.removeTypingIndicator();
            currentMessageElement.dataset.rawText += data.chunk;
            currentMessageElement.textContent = currentMessageElement.dataset.rawText;
            ShopAIChat.UI.scrollToBottom();
            break;

          case 'message_complete':
            ShopAIChat.UI.removeTypingIndicator();
            ShopAIChat.Formatting.formatMessageContent(currentMessageElement);
            ShopAIChat.UI.scrollToBottom();
            break;

          case 'end_turn':
            ShopAIChat.UI.removeTypingIndicator();
            break;

          case 'error':
            console.error('Stream error:', data.error);
            ShopAIChat.UI.removeTypingIndicator();
            currentMessageElement.textContent = "Sorry, I couldn't process your request. Please try again later.";
            break;

          case 'rate_limit_exceeded':
            console.error('Rate limit exceeded:', data.error);
            ShopAIChat.UI.removeTypingIndicator();
            currentMessageElement.textContent = "Sorry, our servers are currently busy. Please try again later.";
            break;

          // preview_ready is handled by the handlePreviewReady() early-return above (Fix 4) —
          // no case needed here.

          case 'auth_required':
            // Save the last user message for resuming after authentication
            sessionStorage.setItem('shopAiLastMessage', userMessage || '');
            break;

          case 'product_results':
            ShopAIChat.UI.displayProductResults(data.products);
            break;

          // Phase 14 — structured fragrance-recommendation events. The backend already scored,
          // filtered, and ratio'd these deterministically; this just renders what it returned,
          // never reformats or re-narrates the numbers itself.
          case 'combination_recommendations':
          case 'recommendation_refined':
            ShopAIChat.UI.removeTypingIndicator();
            if (data.combinations) {
              ShopAIChat.UI.displayCombinationRecommendations(data.combinations);
            }
            break;

          case 'tool_use':
            if (data.tool_use_message) {
              ShopAIChat.Message.addToolUse(data.tool_use_message, messagesContainer);
            }
            break;

          case 'new_message':
            ShopAIChat.Formatting.formatMessageContent(currentMessageElement);
            ShopAIChat.UI.showTypingIndicator();

            // Create new message element for the next response
            const newMessageElement = document.createElement('div');
            newMessageElement.classList.add('shop-ai-message', 'assistant');
            newMessageElement.textContent = '';
            newMessageElement.dataset.rawText = '';
            messagesContainer.appendChild(newMessageElement);

            // Update the current element reference
            updateCurrentElement(newMessageElement);
            break;

          case 'content_block_complete':
            ShopAIChat.UI.showTypingIndicator();
            break;
        }
      },

      /**
       * Fetch chat history from the server
       * @param {string} conversationId - Conversation ID
       * @param {HTMLElement} messagesContainer - The messages container
       */
      fetchChatHistory: async function(conversationId, messagesContainer) {
        try {
          // Show a loading message
          const loadingMessage = document.createElement('div');
          loadingMessage.classList.add('shop-ai-message', 'assistant');
          loadingMessage.textContent = "Loading conversation history...";
          messagesContainer.appendChild(loadingMessage);

          // Fetch history from the server
          const historyUrl = `${getApiBaseUrl()}/chat?history=true&conversation_id=${encodeURIComponent(conversationId)}`;
          console.log('Fetching history from:', historyUrl);

          const response = await fetch(historyUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'ngrok-skip-browser-warning': 'true'
            },
            mode: 'cors'
          });

          if (!response.ok) {
            console.error('History fetch failed:', response.status, response.statusText);
            throw new Error('Failed to fetch chat history: ' + response.status);
          }

          const data = await response.json();

          // Remove loading message
          messagesContainer.removeChild(loadingMessage);

          // No messages, show welcome message
          if (!data.messages || data.messages.length === 0) {
            // Fix (static greeting asked a question the backend never sees) — this text is purely client-side
// and is never sent to the backend as history, so the AI has no memory that a question was asked
// here; the customer's reply was being treated as a cold, context-free answer to nothing. A plain
// greeting avoids that mismatch — the backend's own first real question (name, then day) starts
// fresh once the customer actually replies.
const welcomeMessage = window.shopChatConfig?.welcomeMessage || "Hi there! 👋";
            // Fix (static frontend greeting invisible to the backend) — remembered here so the
            // very first real message sent can pass it along to the backend (see Message.send),
            // letting the model know this greeting already happened instead of having no memory
            // of it at all.
            sessionStorage.setItem('shopAiPendingGreeting', welcomeMessage);
            ShopAIChat.Message.add(welcomeMessage, 'assistant', messagesContainer);
            return;
          }

          // Add messages to the UI - filter out tool results
          data.messages.forEach(message => {
            try {
              const messageContents = JSON.parse(message.content);
              for (const contentBlock of messageContents) {
                if (contentBlock.type === 'text') {
                  ShopAIChat.Message.add(contentBlock.text, message.role, messagesContainer);
                }
              }
            } catch (e) {
              ShopAIChat.Message.add(message.content, message.role, messagesContainer);
            }
          });

          // Scroll to bottom
          ShopAIChat.UI.scrollToBottom();

        } catch (error) {
          console.error('Error fetching chat history:', error);

          // Remove loading message if it exists
          const loadingMessage = messagesContainer.querySelector('.shop-ai-message.assistant');
          if (loadingMessage && loadingMessage.textContent === "Loading conversation history...") {
            messagesContainer.removeChild(loadingMessage);
          }

          // Show error and welcome message
          // Fix (static greeting asked a question the backend never sees) — this text is purely client-side
// and is never sent to the backend as history, so the AI has no memory that a question was asked
// here; the customer's reply was being treated as a cold, context-free answer to nothing. A plain
// greeting avoids that mismatch — the backend's own first real question (name, then day) starts
// fresh once the customer actually replies.
const welcomeMessage = window.shopChatConfig?.welcomeMessage || "Hi there! 👋";
            // Fix (static frontend greeting invisible to the backend) — remembered here so the
            // very first real message sent can pass it along to the backend (see Message.send),
            // letting the model know this greeting already happened instead of having no memory
            // of it at all.
            sessionStorage.setItem('shopAiPendingGreeting', welcomeMessage);
          ShopAIChat.Message.add(welcomeMessage, 'assistant', messagesContainer);

          // Clear the conversation ID since we couldn't fetch this conversation
          sessionStorage.removeItem('shopAiConversationId');
        }
      }
    },

    /**
     * Product-related functionality
     */
    Product: {
      /**
       * Create a product card element
       * @param {Object} product - Product data
       * @returns {HTMLElement} Product card element
       */
      createCard: function(product) {
        const card = document.createElement('div');
        card.classList.add('shop-ai-product-card');

        // Create image container
        const imageContainer = document.createElement('div');
        imageContainer.classList.add('shop-ai-product-image');

        // Add product image or placeholder
        const image = document.createElement('img');
        image.src = product.image_url || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
        image.alt = product.title;
        image.onerror = function() {
          // If image fails to load, use a fallback placeholder
          this.src = 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
        };
        imageContainer.appendChild(image);
        card.appendChild(imageContainer);

        // Add product info
        const info = document.createElement('div');
        info.classList.add('shop-ai-product-info');

        // Add product title
        const title = document.createElement('h3');
        title.classList.add('shop-ai-product-title');
        title.textContent = product.title;

        // If product has a URL, make the title a link
        if (product.url) {
          const titleLink = document.createElement('a');
          titleLink.href = product.url;
          titleLink.target = '_blank';
          titleLink.textContent = product.title;
          title.textContent = '';
          title.appendChild(titleLink);
        }

        info.appendChild(title);

        // Add product price
        const price = document.createElement('p');
        price.classList.add('shop-ai-product-price');
        price.textContent = product.price;
        info.appendChild(price);

        // Add add-to-cart button
        const button = document.createElement('button');
        button.classList.add('shop-ai-add-to-cart');
        button.textContent = 'Add to Cart';
        button.dataset.productId = product.id;

        // Add click handler for the button
        button.addEventListener('click', function() {
          // Send message to add this product to cart
          const input = document.querySelector('.shop-ai-chat-input input');
          if (input) {
            input.value = `Add ${product.title} to my cart`;
            // Trigger a click on the send button
            const sendButton = document.querySelector('.shop-ai-chat-send');
            if (sendButton) {
              sendButton.click();
            }
          }
        });

        info.appendChild(button);
        card.appendChild(info);

        return card;
      }
    },

    /**
     * Fragrance combination recommendation cards (Phase 14). Every action button prefills a plain
     * natural-language message and reuses the existing chat send pipeline — there's no separate
     * API path; the backend's tool-calling loop (confirm_product_combination etc.) does the real
     * work from the customer's own words, exactly like the existing "Add to Cart" button does.
     */
    Combination: {
      CONFIDENCE_LABELS: { 'very high': 'Very High', high: 'High', medium: 'Medium', low: 'Low' },

      // Real product names/notes now render via innerHTML (for the <strong>/<em> markup) — escape
      // first so a title/note containing &, <, or > can never be interpreted as markup.
      escapeHtml: function(str) {
        const div = document.createElement('div');
        div.textContent = String(str == null ? '' : str);
        return div.innerHTML;
      },

      /**
       * @param {Object} combo - one customer-safe recommendation (recommendationId, type,
       *   customerFacingName/Description/WhySuits/BestUse/WeatherSuitability/Strength/Risk,
       *   confidence, evidenceScope, existsAlready). Fix 3: real source product titles/notes are
       *   never sent to the frontend at all — only these customer-facing fields exist here.
       * @param {number} rank - 1-based display rank.
       * @returns {HTMLElement}
       */
      createCard: function(combo, rank) {
        const card = document.createElement('div');
        card.classList.add('shop-ai-combo-card');

        const badge = document.createElement('span');
        badge.classList.add('shop-ai-combo-badge', combo.existsAlready ? 'is-existing' : 'is-new');
        badge.textContent = combo.existsAlready ? 'Existing verified combination' : 'New custom combination';
        card.appendChild(badge);

        const title = document.createElement('h5');
        title.classList.add('shop-ai-combo-title');
        title.textContent = `#${rank} · ${combo.customerFacingName || combo.type || ''}`;
        card.appendChild(title);

        const typeLine = document.createElement('p');
        typeLine.classList.add('shop-ai-combo-type');
        typeLine.textContent = combo.type || '';
        card.appendChild(typeLine);

        if (combo.customerFacingDescription) {
          const character = document.createElement('p');
          character.classList.add('shop-ai-combo-character');
          character.textContent = combo.customerFacingDescription;
          card.appendChild(character);
        }

        if (combo.customerFacingWhySuits) {
          const why = document.createElement('p');
          why.classList.add('shop-ai-combo-why');
          why.textContent = combo.customerFacingWhySuits;
          card.appendChild(why);
        }

        // Fix (Aniq spec, sections 11/25) — real component names, notes, ratio, and contribution
        // role, shown directly (this reverses the earlier "Product 1/2/3" generic-label design per
        // this spec's explicit instruction to show real product names).
        if (Array.isArray(combo.components) && combo.components.length) {
          const componentsList = document.createElement('ul');
          componentsList.classList.add('shop-ai-combo-components');
          combo.components.forEach((c) => {
            const item = document.createElement('li');
            const ratioText = typeof c.ratioPercent === 'number' ? ` — ${c.ratioPercent}%` : '';
            const notesText = Array.isArray(c.availableNotes) && c.availableNotes.length ? c.availableNotes.join(', ') : '';
            item.innerHTML =
              '<strong>' + this.escapeHtml(c.productName || '') + '</strong>' + this.escapeHtml(ratioText) +
              (c.contribution ? ' <em>(' + this.escapeHtml(c.contribution) + ')</em>' : '') +
              (notesText ? '<br>' + this.escapeHtml(notesText) : '');
            componentsList.appendChild(item);
          });
          card.appendChild(componentsList);
        }

        // Expandable detail section — native <details>/<summary>, no extra JS needed for
        // expand/collapse. Covers combinedDirection, sharedOrConnectingNotes, whyNotesWork,
        // expectedResult, historical evidence, and existing-combination evidence.
        const hasDetail = combo.sharedOrConnectingNotes?.length || combo.whyNotesWork || combo.expectedResult ||
          combo.customerFacingHistoricalEvidence || combo.existingCombinationEvidence;
        if (hasDetail) {
          const details = document.createElement('details');
          details.classList.add('shop-ai-combo-details');
          const summary = document.createElement('summary');
          summary.textContent = 'See full evidence and explanation';
          details.appendChild(summary);

          const addDetailLine = (label, value) => {
            if (!value) return;
            const p = document.createElement('p');
            p.classList.add('shop-ai-combo-detail-line');
            p.innerHTML = '<strong>' + this.escapeHtml(label) + ':</strong> ' + this.escapeHtml(value);
            details.appendChild(p);
          };

          if (combo.sharedOrConnectingNotes?.length) addDetailLine('Shared/connecting notes', combo.sharedOrConnectingNotes.join(', '));
          addDetailLine('Why the notes work', combo.whyNotesWork);
          addDetailLine('Expected result', combo.expectedResult);
          const evidence = combo.customerFacingHistoricalEvidence;
          if (evidence) {
            addDetailLine('City evidence', evidence.cityEvidence);
            addDetailLine('Country evidence', evidence.countryEvidence);
            addDetailLine('Seasonal evidence', evidence.seasonalEvidence);
            addDetailLine('Repeat-purchase evidence', evidence.repeatEvidence);
            addDetailLine('Data window', evidence.dataWindow);
          }
          if (combo.existingCombinationEvidence?.similarEvidence?.length) {
            addDetailLine(
              'Similar existing combinations',
              combo.existingCombinationEvidence.similarEvidence.map((e) => e.title).join(', '),
            );
          }
          card.appendChild(details);
        }

        if (combo.customerFacingBestUse) {
          const bestUse = document.createElement('p');
          bestUse.classList.add('shop-ai-combo-best-use');
          bestUse.textContent = combo.customerFacingBestUse;
          card.appendChild(bestUse);
        }

        if (combo.customerFacingWeatherSuitability) {
          const weather = document.createElement('p');
          weather.classList.add('shop-ai-combo-weather');
          weather.textContent = combo.customerFacingWeatherSuitability;
          card.appendChild(weather);
        }

        if (combo.customerFacingStrength) {
          const strength = document.createElement('p');
          strength.classList.add('shop-ai-combo-strength');
          strength.textContent = `Strength: ${combo.customerFacingStrength}`;
          card.appendChild(strength);
        }

        if (combo.confidence) {
          const confidence = document.createElement('span');
          const confidenceKey = String(combo.confidence).toLowerCase().replace(/\s+/g, '-');
          confidence.classList.add('shop-ai-combo-confidence', `is-confidence-${confidenceKey}`);
          confidence.textContent = `Confidence: ${this.CONFIDENCE_LABELS[combo.confidence] || combo.confidence}`;
          card.appendChild(confidence);
        }

        if (combo.customerFacingRisk) {
          const risk = document.createElement('p');
          risk.classList.add('shop-ai-combo-risk');
          risk.textContent = '⚠ ' + combo.customerFacingRisk;
          card.appendChild(risk);
        }

        const actions = document.createElement('div');
        actions.classList.add('shop-ai-combo-actions');

        // Fix 6 — sent as plain rank-based text ("Option N"), never a reconstructed product list
        // (the frontend never has the real product names to reconstruct from anyway). The
        // backend's select_recommendation tool resolves this deterministically against the
        // currently active recommendation list, by rank.
        const selectButton = document.createElement('button');
        selectButton.classList.add('shop-ai-combo-select');
        selectButton.textContent = 'Select';
        selectButton.addEventListener('click', () => {
          this.sendPrefilled(`Option ${rank} looks great — let's go with that one.`, true);
        });
        actions.appendChild(selectButton);

        const refineButton = document.createElement('button');
        refineButton.classList.add('shop-ai-combo-refine');
        refineButton.textContent = 'Refine';
        refineButton.addEventListener('click', () => {
          this.sendPrefilled(`For option ${rank}, I'd like to `, false);
        });
        actions.appendChild(refineButton);

        const createButton = document.createElement('button');
        createButton.classList.add('shop-ai-combo-create');
        createButton.textContent = 'Create My Fragrance';
        createButton.addEventListener('click', () => {
          this.sendPrefilled(`Yes, please create option ${rank} for me.`, true);
        });
        actions.appendChild(createButton);

        card.appendChild(actions);

        return card;
      },

      /**
       * Puts `text` in the chat input, optionally sending it immediately — the same mechanism the
       * existing "Add to Cart" product-card button already uses.
       * @param {string} text
       * @param {boolean} autoSend
       */
      sendPrefilled: function(text, autoSend) {
        const input = document.querySelector('.shop-ai-chat-input input');
        if (!input) return;
        input.value = text;
        if (autoSend) {
          const sendButton = document.querySelector('.shop-ai-chat-send');
          if (sendButton) sendButton.click();
        } else {
          input.focus();
        }
      }
    },

    /**
     * Initialize the chat application. This script only ever loads for a logged-in customer (see
     * the {% if customer %} gate in chat-interface.liquid) — no client-side login check needed.
     */
    init: function() {
      const container = document.querySelector('.shop-ai-chat-container');
      if (!container) return;

      this.customerEmail = window.shopCustomerEmail || null;
      this.customerName = window.shopCustomerName || null;
      this.start(container);
    },

    /**
     * Proceed with normal chat setup once the customer's email is known.
     * @param {HTMLElement} container - The main container element
     */
    start: function(container) {
      this.UI.init(container);

      // Check for existing conversation
      const conversationId = sessionStorage.getItem('shopAiConversationId');

      if (conversationId) {
        // Fetch conversation history
        this.API.fetchChatHistory(conversationId, this.UI.elements.messagesContainer);
      } else {
        // No previous conversation — show the date divider once, then the welcome message
        const divider = document.createElement('div');
        divider.className = 'shop-ai-date-divider';
        divider.textContent = 'Today';
        this.UI.elements.messagesContainer.appendChild(divider);

        // Fix (static greeting asked a question the backend never sees) — this text is purely client-side
// and is never sent to the backend as history, so the AI has no memory that a question was asked
// here; the customer's reply was being treated as a cold, context-free answer to nothing. A plain
// greeting avoids that mismatch — the backend's own first real question (name, then day) starts
// fresh once the customer actually replies.
const welcomeMessage = window.shopChatConfig?.welcomeMessage || "Hi there! 👋";
            // Fix (static frontend greeting invisible to the backend) — remembered here so the
            // very first real message sent can pass it along to the backend (see Message.send),
            // letting the model know this greeting already happened instead of having no memory
            // of it at all.
            sessionStorage.setItem('shopAiPendingGreeting', welcomeMessage);
        this.Message.add(welcomeMessage, 'assistant', this.UI.elements.messagesContainer);
      }
    }
  };

  // Initialize the application when DOM is ready
  document.addEventListener('DOMContentLoaded', function() {
    ShopAIChat.init();
  });
})();
