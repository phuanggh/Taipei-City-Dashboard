import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import http from "../router/axios";

export const useChatStore = defineStore('chat', () => {
  	// 預設訊息
  	const defaultChatData = [
    	{
      		id: 1,
      		role: 'bot',
		  	isDefault: true,
      		content:
        	'您好，我是【臺北城市儀表板】小幫手，很高興為您服務！\n 您可以： \n\n • 點擊左側既有的儀表板主題，快速查看各主題內容 \n • 輸入您感興趣的主題描述，我會自動為您組建最適合的儀表板 \n\n 如果有想了解的內容，歡迎直接告訴我，我會盡力協助！\n\n 📩 聯絡信箱：tuic@gov.taipei \n 🏢 臺北大數據中心 \n\n',
    	},
  	];

	const recommendComponents = ref(null)

  	// 從 sessionStorage 讀取
  	const savedChatData = JSON.parse(sessionStorage.getItem('chatData')) || [];

  	// 拼接預設訊息 + sessionStorage 的聊天紀錄
  	const chatData = ref([...defaultChatData, ...savedChatData]);

	// 同一個 session 內的對話歷史（提供給 LLM 做多輪對話）
	const llmHistory = ref(JSON.parse(sessionStorage.getItem('llmHistory')) || []);

	// 本次 session ID
	const sessionID = sessionStorage.getItem('llmSessionID') || (() => {
		const id = 'session_' + Date.now();
		sessionStorage.setItem('llmSessionID', id);
		return id;
	})();

  	// 監聽 chatData 的變化，自動同步到 sessionStorage
  	watch(
    	chatData,
    	(newVal) => {
      	const userBotMessages = newVal.filter((item) => !item.isDefault)
      	sessionStorage.setItem('chatData', JSON.stringify(userBotMessages))
    	},
    	{ deep: true }
  	);

	watch(
		llmHistory,
		(newVal) => {
			sessionStorage.setItem('llmHistory', JSON.stringify(newVal))
		},
		{ deep: true }
	);

  	const addChatData = (newChatData) => {
    	chatData.value.push({ id: chatData.value.length + 1, isDefault: false, ...newChatData });
  	};

	// LLM 工具定義：search_components
	const TOOLS = [{
		type: 'function',
		function: {
			name: 'search_components',
			description: '搜尋臺北城市儀表板中與主題相關的組件清單，當使用者想找組件、查詢特定主題的資料視覺化時使用。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '搜尋關鍵字或主題描述，例如「空氣品質」、「交通事故」' },
					limit: { type: 'integer', description: '回傳組件數量上限，預設 5，最多 10' }
				},
				required: ['query']
			}
		}
	}];

	const SYSTEM_PROMPT = `你是「臺北城市儀表板」的 AI 小幫手。
你可以：
1. 協助使用者尋找儀表板組件（請呼叫 search_components 工具）
2. 回答與臺北城市數據、組件功能相關的問題

規則：
- 使用者若詢問要找哪些組件、哪些資料，請呼叫 search_components
- 回應請使用繁體中文
- 回應請簡潔清楚`;

	// 呼叫 TWCC LLM（串流），登入後使用
	const chatWithLLM = async (userText) => {
		// 1. 顯示使用者訊息
		chatData.value.push({ id: chatData.value.length + 1, role: 'user', isDefault: false, content: userText });

		// 2. 加入串流佔位訊息
		const botMsgId = chatData.value.length + 1;
		chatData.value.push({ id: botMsgId, role: 'bot', isDefault: false, content: '', isStreaming: true });

		// 3. 更新 LLM 歷史（加入這次使用者訊息）
		llmHistory.value.push({ role: 'user', content: userText });

		// 4. 組合訊息：system + 對話歷史
		const messages = [
			{ role: 'system', content: SYSTEM_PROMPT },
			...llmHistory.value
		];

		const token = localStorage.getItem('token');
		const baseURL = import.meta.env.VITE_API_URL || '';

		let fullContent = '';

		try {
			const response = await fetch(`${baseURL}/ai/chat/twai`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${token}`
				},
				body: JSON.stringify({
					session: sessionID,
					stream: true,
					tools: TOOLS,
					messages
				})
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			const botMsg = chatData.value.find(m => m.id === botMsgId);

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const raw = decoder.decode(value, { stream: true });
				for (const line of raw.split('\n')) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data:')) continue;
					const jsonStr = trimmed.slice(5).trim();
					if (jsonStr === '[DONE]') continue;
					try {
						const chunk = JSON.parse(jsonStr);
						const token = chunk.choices?.[0]?.delta?.content ?? chunk.generated_text ?? '';
						if (token && botMsg) {
							botMsg.content += token;
							fullContent += token;
						}
					} catch (_) { /* 略過非 JSON 行 */ }
				}
			}
		} catch (err) {
			const botMsg = chatData.value.find(m => m.id === botMsgId);
			if (botMsg) botMsg.content = '很抱歉，AI 服務發生錯誤，請稍後再試。';
			console.error('chatWithLLM error:', err);
		} finally {
			// 移除串流中標記
			const botMsg = chatData.value.find(m => m.id === botMsgId);
			if (botMsg) botMsg.isStreaming = false;
		}

		// 5. 將 AI 回覆加入歷史（只保留最近 20 輪避免超過 token 限制）
		if (fullContent) {
			llmHistory.value.push({ role: 'assistant', content: fullContent });
			if (llmHistory.value.length > 40) {
				llmHistory.value = llmHistory.value.slice(-40);
			}
		}
	};

	// 向量語意搜尋（未登入時使用）
  	const addQueryData = async (newChatData) => {
    	chatData.value.push({ id: chatData.value.length + 1, isDefault: false, ...newChatData });

		recommendComponents.value = [];
		let topK = null;

		try {
			const response = await http.post(
  				"/vector/component",
  				new URLSearchParams({
    				query: newChatData.content,
    				limit: 10,
    				score: 0.8,
  				}),
  				{
    				headers: {
      					"Content-Type": "application/x-www-form-urlencoded",
    				},
  				}
			);
			if (response.data?.data?.length > 0) {
				recommendComponents.value = response.data.data;
			}

			const result = Array.from(
  				recommendComponents.value.reduce((map, item) => {
    				const key = item.index
    				const exist = map.get(key)
    				if (!exist) {
      					map.set(key, item)
      					return map
    				}
    				if (item.city === 'metrotaipei') {
      					map.set(key, item)
    				}
    				return map
  				}, new Map()).values()
			)
			recommendComponents.value = result

		} catch (error) {
			console.error("VectorAnalysisError :", error);
		}

		if (recommendComponents.value && recommendComponents.value?.length > 0) {
			topK = [...recommendComponents.value].sort((a, b) => b.score - a.score);
			chatData.value.push({ id: chatData.value.length + 1, role: 'bot', isDefault: false, button: [{ id:1, text:'建立儀表板' }], content: `您好 😊 \n 以下是根據您的問題，自動為您推薦的「組件清單」。您可以將這些組件整批加入「個人儀表板」，方便日後快速查看與使用。\n`, relations: topK });
			chatData.value.push({ id: chatData.value.length + 1, role: 'bot', isDefault: false, content: `若您有任何新的查詢或想深入探索的內容，都可以隨時在對話框告訴我～\n 我很樂意再協助您 💬✨` });
		} else {
			chatData.value.push({ id: chatData.value.length + 1, role: 'bot', isDefault: false, content: `很抱歉，您提供的描述沒有相似組件，請繼續提問 ! ` });
		}

		saveChatLog(newChatData.content, recommendComponents.value);
  	};

	const saveChatLog = async(question, answer) => {
		try {
        	const formData = new FormData();
        	const d = new Date();
        	const todayId =
          		d.getFullYear() +
          		String(d.getMonth() + 1).padStart(2, "0") +
          		String(d.getDate()).padStart(2, "0");

        	formData.append("session", "session_" + todayId);
        	formData.append("question", question);
        	formData.append("answer", JSON.stringify(answer));

        	await http.post("/chatlog/", formData, {
          		headers: {
            		"Content-Type": "multipart/form-data",
          		},
        	});
      	} catch (error) {
        	console.error("saveChatLog error:", error);
      	}
	};

	return { chatData, addChatData, addQueryData, saveChatLog, chatWithLLM }
})
