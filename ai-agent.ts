// ============================================
// OrthoSleep CRM — AI-агент для автоматического общения с клиентами
// Supabase Edge Function
//
// Вызывается из webhook'ов (instagram-webhook, facebook-webhook) сразу после
// сохранения входящего сообщения от клиента. Агент:
// 1. Собирает контекст: историю переписки, товары, профиль клиента
// 2. Решает — отвечать самому или передать менеджеру
// 3. Считает точные цены через ту же формулу, что и калькулятор в CRM
// 4. При реальном интересе создаёт сделку с товарами
// 5. Отвечает клиенту на таджикском (по умолчанию) или русском (если клиент сам перешёл)
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ============================================
// КАЛЬКУЛЯТОР ЦЕНЫ — точно та же формула, что в CRM (цена за см × ширина × скидка)
// ============================================

function calculatePrice(pricePerCm: number, width: number, discountPercent: number): number {
  const rawPrice = pricePerCm * width;
  return Math.round(rawPrice * (1 - discountPercent / 100));
}

// ============================================
// СБОР КОНТЕКСТА ДЛЯ AI
// ============================================

async function buildContext(adminClient: ReturnType<typeof createClient>, clientId: number) {
  const now = new Date().toISOString();
  const [clientRes, historyRes, productsRes, settingsRes, dealsRes, promotionsRes, businessInfoRes, stagesRes, learningRes] = await Promise.all([
    adminClient.from('clients').select('*').eq('id', clientId).single(),
    adminClient.from('messages').select('*').eq('client_id', clientId).order('created_at', { ascending: true }).limit(15),
    adminClient.from('products').select('*').eq('is_active', true),
    adminClient.from('ai_agent_settings').select('*').eq('id', 1).single(),
    adminClient.from('deals').select('*, pipeline_stages(name,is_won,is_lost)').eq('client_id', clientId).order('created_at', { ascending: false }).limit(3),
    adminClient.from('promotions').select('*').eq('is_active', true).lte('starts_at', now).gte('ends_at', now),
    adminClient.from('business_info').select('*'),
    adminClient.from('pipeline_stages').select('*').order('sort_order'),
    adminClient.from('ai_learning_examples').select('*').eq('is_approved', true).order('created_at', { ascending: false }).limit(0),
  ]);

  return {
    client: clientRes.data,
    history: historyRes.data || [],
    products: productsRes.data || [],
    settings: settingsRes.data,
    recentDeals: dealsRes.data || [],
    activePromotions: promotionsRes.data || [],
    businessInfo: businessInfoRes.data || [],
    pipelineStages: stagesRes.data || [],
    learningExamples: learningRes.data || [],
  };
}

// ============================================
// ФОРМИРОВАНИЕ СИСТЕМНОГО ПРОМПТА ДЛЯ CLAUDE
// ============================================

function buildSystemPrompt(context: ReturnType<typeof buildContext> extends Promise<infer T> ? T : never): string {
  const { settings, products, client, recentDeals, activePromotions, businessInfo, pipelineStages, learningExamples } = context;

  const productsCatalog = products
    .map((p: any) => {
      const calcInfo = p.price_per_cm
        ? `цена за 1 см ширины: ${p.price_per_cm} сом (база 180×200 = ${calculatePrice(p.price_per_cm, 180, 0)} сом), стандартная скидка до ${p.max_discount_percent || 20}%, минимальная цена ${p.min_price || 'не ограничена'} сом. Можно изготовить любой нестандартный размер по этой же формуле.`
        : `фиксированная цена ${p.sale_price} сом`;
      const description = p.description ? ` Особенности: ${p.description}.` : '';
      const photoInfo = p.photo_url ? ` [PRODUCT_ID=${p.id}]` : '';
      return `- ${p.name}${p.size ? ' (стандарт ' + p.size + ')' : ''}${photoInfo}: ${calcInfo}.${description}`;
    })
    .join('\n');

  const dealsInfo = recentDeals.length
    ? recentDeals.map((d: any) => `Сделка №${d.id}: ${d.pipeline_stages?.name}, сумма ${d.amount} сом`).join('\n')
    : 'У клиента пока нет сделок.';

  const promotionsInfo = activePromotions.length
    ? activePromotions
        .map((promo: any) => {
          const productName = promo.applies_to_product_id
            ? products.find((p: any) => p.id === promo.applies_to_product_id)?.name || 'товар'
            : 'все товары';
          return `- ${promo.title} (действует для: ${productName}): ${promo.description}${promo.discount_percent ? ` — скидка ${promo.discount_percent}%` : ''}`;
        })
        .join('\n')
    : 'Сейчас действующих акций нет — называй обычные цены без специальных скидок по акции.';

  const businessInfoText = businessInfo.length
    ? businessInfo.map((b: any) => `${b.title}: ${b.content}`).join('\n')
    : '';

  return `${settings?.system_prompt || 'Ты — продавец-консультант OrthoSleep.'}

═══════════════════════════════════
КТО ТЫ
═══════════════════════════════════
Ты — продавец-консультант OrthoSleep с более чем 20-летним опытом продаж матрасов и мебели для сна. Ты знаешь и применяешь лучшие техники продаж (SPIN, консультативная продажа, работа с возражениями) естественно, без того чтобы это выглядело "по учебнику". Твоя цель — не просто ответить на вопрос, а провести клиента к покупке: понять его реальную потребность, подобрать вариант, снять сомнения и довести до оформления заказа. Ты дружелюбный, терпеливый, никогда не давишь и не навязываешь — ты помогаешь клиенту принять правильное для него решение.

Клиент не должен понимать, что общается с автоматической системой — веди себя как живой опытный продавец. Никогда не упоминай слова "AI", "бот", "искусственный интеллект", "автоматический".

═══════════════════════════════════
ЯЗЫК
═══════════════════════════════════
По умолчанию ВСЕГДА начинай и веди разговор на таджикском языке — это касается и первого сообщения новому клиенту, даже если в истории пока пусто. Переходи на русский ТОЛЬКО если клиент сам написал тебе сообщение на русском языке. Если клиент пишет на русском — дальше веди весь разговор на русском. Никогда не смешивай два языка в одном сообщении.

═══════════════════════════════════
ГЛАВНОЕ ПРАВИЛО ПРОДАЖ: НЕ НАЗЫВАЙ ЦЕНУ СРАЗУ
═══════════════════════════════════
Если клиент с первого сообщения спрашивает "сколько стоит" без уточнения размера — НЕ называй цену в первом ответе. Сначала задай 1-2 уточняющих вопроса, чтобы понять потребность, и только после этого называй точную цену под его запрос. Примеры того, что нужно уточнить перед ценой:
- Какой размер матраса нужен (для какой кровати — односпальная, двуспальная, конкретные размеры)
- Какая жёсткость предпочтительна, есть ли проблемы со спиной
- На какой бюджет рассчитывает (необязательно спрашивать прямо, можно через "какой вариант вас интересует — бюджетный или премиальный")

После того как уточнил хотя бы один из этих параметров — называй точную цену уверенно и конкретно, без лишних колебаний. Не превращай уточнение в допрос — достаточно 1-2 коротких дружелюбных вопросов, потом переходи к делу.

Если клиент уже сам назвал точный размер в своём сообщении (например "хочу 160 на 200") — можешь сразу называть цену, не нужно переспрашивать то, что он уже сказал.

═══════════════════════════════════
НЕ ГОВОРИ КЛИЕНТУ ПРО ОСТАТКИ НА СКЛАДЕ
═══════════════════════════════════
Информация о количестве штук на складе — только для тебя, для принятия решений (например если 0 на складе — предложи альтернативную модель или скажи "сделаем на заказ"). Никогда не произноси клиенту фразы вроде "у нас на складе 14 штук" — это непрофессионально звучит и не нужно покупателю.

═══════════════════════════════════
ЛЮБОЙ РАЗМЕР МОЖНО ИЗГОТОВИТЬ
═══════════════════════════════════
У OrthoSleep можно заказать матрас любого нестандартного размера — не только стандартные 160x200, 180x200 и т.д. Если клиент называет нестандартный размер — спокойно подтверди, что это возможно, и посчитай цену по формуле (цена за см ширины × ширина).

═══════════════════════════════════
КАТАЛОГ ТОВАРОВ И ЦЕНЫ
═══════════════════════════════════
${productsCatalog || 'Каталог пуст.'}

═══════════════════════════════════
ДЕЙСТВУЮЩИЕ АКЦИИ
═══════════════════════════════════
${promotionsInfo}

═══════════════════════════════════
ИНФОРМАЦИЯ О БИЗНЕСЕ (доставка, оплата, контакты)
═══════════════════════════════════
${businessInfoText || 'Информация не заполнена.'}

═══════════════════════════════════
КАК СЧИТАТЬ ЦЕНУ ПОД ЛЮБОЙ РАЗМЕР
═══════════════════════════════════
Цена = (цена за см × ширина в см) × (1 − скидка/100). Длина почти всегда 200 см. Считай точно, не округляй грубо. Никогда не озвучивай скидку больше максимальной для этой модели и никогда не называй цену ниже минимальной — в этих случаях скажи, что точную скидку нужно уточнить у менеджера, и подготовь передачу диалога. Если есть действующая акция на товар — используй её скидку вместо стандартной, но не превышай максимально разрешённую скидку модели.

═══════════════════════════════════
ИСТОРИЯ СДЕЛОК ЭТОГО КЛИЕНТА
═══════════════════════════════════
${dealsInfo}

═══════════════════════════════════
КОГДА ПЕРЕДАВАТЬ ЖИВОМУ МЕНЕДЖЕРУ
═══════════════════════════════════
- Жалоба, претензия, возврат денег, брак товара
- Просьба о скидке больше максимальной по модели
- Клиент явно злится, груб, или конфликтная ситуация
- Вопрос, на который в каталоге, акциях, бизнес-информации и истории нет ответа
- Любая ситуация, где ты не уверен, что отвечаешь верно

Если нужно передать человеку — установи needs_human true и коротко опиши причину в escalation_reason.

═══════════════════════════════════
КОГДА КЛИЕНТ ПРОСИТ НАПИСАТЬ ПОЗЖЕ
═══════════════════════════════════
Если клиент явно говорит "напиши мне через час", "позвони завтра", "напомни через 3 дня" и подобное — заполни schedule_followup с точным переводом его просьбы в минуты. Это создаст напоминание менеджеру на нужное время — не забывай это делать, иначе просьба клиента будет потеряна.

═══════════════════════════════════
КОГДА СОЗДАВАТЬ СДЕЛКУ
═══════════════════════════════════
Если клиент явно выразил готовность купить (назвал модель и подтвердил, что оформляем, либо согласился с названной ценой и хочет заказать) — установи create_deal true и заполни deal_info (product_name, size, price, qty).

ЭТАПЫ ВОРОНКИ ПРОДАЖ (используй точные названия в stage_name, когда нужно продвинуть сделку):
${pipelineStages.map((s: any) => `- ${s.name}`).join('\n')}

Если у клиента уже есть открытая сделка и разговор показывает прогресс — указывай stage_name, чтобы продвинуть её (например клиент подтвердил, что переводит оплату — поставь этап "Оплачен"; договорились о доставке — "Доставка"). Не указывай stage_name, если не уверен в прогрессе — лучше оставить сделку на текущем этапе, чем продвинуть её ошибочно.

${learningExamples.length ? `═══════════════════════════════════
ПРИМЕРЫ ИЗ РЕАЛЬНЫХ ОТВЕТОВ МЕНЕДЖЕРОВ (учись на них для похожих ситуаций)
═══════════════════════════════════
${learningExamples.map((ex: any) => `Клиент спросил: "${ex.client_question}"\nМенеджер ответил: "${ex.manager_answer}"`).join('\n---\n')}
` : ''}

═══════════════════════════════════
ФОРМАТ ОТВЕТА
═══════════════════════════════════
Пиши reply как обычное сообщение в мессенджере — без markdown-разметки (без звёздочек **жирный**, без решёток ## заголовков). Используй обычный текст, как пишут люди в Instagram/WhatsApp, можно эмодзи в меру.`;
}

// ============================================
// ВЫЗОВ CLAUDE API
// ============================================

async function callClaude(systemPrompt, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages,
      tools: [
        {
          name: 'reply_to_client',
          description: 'Отправить структурированный ответ клиенту с решением по сделке и эскалации',
          input_schema: {
            type: 'object',
            properties: {
              reply: { type: 'string', description: 'Текст сообщения клиенту, без markdown-разметки (без звёздочек, решёток и т.п.) — это обычное сообщение в мессенджере' },
              needs_human: { type: 'boolean', description: 'true, если нужно передать диалог живому менеджеру' },
              escalation_reason: { type: ['string', 'null'], description: 'Причина передачи менеджеру, если needs_human true' },
              create_deal: { type: 'boolean', description: 'true, если клиент готов купить и нужно создать сделку, либо если уже есть сделка и нужно продвинуть её этап (например клиент подтвердил оплату)' },
              deal_info: {
                type: ['object', 'null'],
                properties: {
                  product_name: { type: 'string' },
                  size: { type: 'string' },
                  price: { type: 'number' },
                  qty: { type: 'number' },
                  stage_name: { type: 'string', description: 'Название этапа воронки, на который нужно поставить сделку, например "Контакт установлен", "Счёт выставлен", "Оплачен". Указывай только если уверен в прогрессе разговора.' },
                },
              },
              schedule_followup: {
                type: ['object', 'null'],
                description: 'Заполни, если клиент явно попросил написать/связаться с ним позже',
                properties: {
                  minutes_from_now: { type: 'number' },
                  note: { type: 'string' },
                },
              },
              send_photo: {
                type: ['string', 'null'],
                description: 'ID товара из каталога чьё фото нужно отправить. ВСЕГДА указывай когда называешь конкретную модель впервые или клиент просит фото. Укажи точный product_id из списка товаров. Если не знаешь ID — укажи название модели точно как в каталоге (Sultan/Rayana/Marva).',
              },
              update_client: {
                type: ['object', 'null'],
                description: 'Заполни если в ходе разговора клиент назвал свой номер телефона, город или другие данные которые нужно сохранить в его карточку.',
                properties: {
                  phone: { type: 'string', description: 'Номер телефона если клиент его написал' },
                  city: { type: 'string', description: 'Город/населённый пункт если клиент его назвал' },
                  lead_status: { type: 'string', enum: ['hot', 'warm', 'cold'], description: 'hot=готов купить/обсуждает детали заказа, warm=проявил интерес спросил цену/размер, cold=просто смотрит или давно не пишет' },
                },
              },
            },
            required: ['reply', 'needs_human', 'create_deal'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'reply_to_client' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Ошибка вызова Claude API:', errText);
    throw new Error(`Claude API error: ${res.status}`);
  }

  const data = await res.json();
  const toolUseBlock = data.content?.find((b) => b.type === 'tool_use');
  if (!toolUseBlock) {
    console.error('Claude не вернул tool_use блок:', JSON.stringify(data));
    throw new Error('Claude did not return structured response');
  }

  // Возвращаем результат вместе с данными об использовании токенов
  return {
    ...toolUseBlock.input,
    _usage: data.usage || null,
  };
}

// ============================================
// ОТПРАВКА ОТВЕТА КЛИЕНТУ ЧЕРЕЗ ПРАВИЛЬНЫЙ КАНАЛ
// ============================================

async function sendImageThroughInstagram(adminClient, client, imageUrl) {
  if (!client.instagram_username) return { success: false, error: 'Нет Instagram ID' };
  const accounts = await getInstagramAccounts(adminClient);
  const account = accounts.find((a) => a.id === client.instagram_account_id) || accounts[0];
  if (!account) return { success: false, error: 'Нет аккаунта' };

  try {
    // Instagram Messaging API использует тип 'media_share' для изображений по URL
    // Правильный формат для отправки изображения через Instagram Direct
    const res = await fetch(`https://graph.instagram.com/v21.0/${account.ig_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: client.instagram_username },
        message: {
          attachment: {
            type: 'image',
            payload: {
              url: imageUrl,
              is_reusable: true,
            },
          },
        },
        messaging_type: 'RESPONSE',
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('Ошибка отправки фото Instagram:', JSON.stringify(data));
      // Если не поддерживается attachment — отправляем ссылку текстом как fallback
      const fallbackRes = await fetch(`https://graph.instagram.com/v21.0/${account.ig_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: client.instagram_username },
          message: { text: imageUrl },
          messaging_type: 'RESPONSE',
        }),
      });
      const fallbackData = await fallbackRes.json();
      if (!fallbackRes.ok) return { success: false, error: JSON.stringify(fallbackData) };
      return { success: true, fallback: true };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function getInstagramAccounts(adminClient) {
  const { data } = await adminClient.from('instagram_accounts').select('*').eq('is_active', true);
  return data || [];
}

async function sendReplyThroughChannel(adminClient, client, text) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  let functionName = null;
  if (client.instagram_username) functionName = 'instagram-webhook';
  else if (client.facebook_id) functionName = 'facebook-webhook';
  else if (client.whatsapp_number) functionName = 'whatsapp-webhook';

  if (!functionName) {
    return { success: false, error: 'У клиента нет привязанного канала' };
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/${functionName}?action=send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      body: JSON.stringify({ client_id: client.id, text, sender: 'ai_agent' }),
    });
    return await res.json();
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ============================================
// СОЗДАНИЕ СДЕЛКИ AI-АГЕНТОМ
// ============================================

/**
 * Создаёт срочную задачу для менеджера, когда AI передаёт диалог человеку.
 * Это и есть "уведомление" внутри CRM — задача появится в разделе Задачи
 * и в списке дел на главной.
 */
async function logActivity(adminClient, category, action, description, opts = {}) {
  try {
    await adminClient.from('activity_logs').insert({
      category,
      action,
      description,
      client_id: opts.clientId || null,
      deal_id: opts.dealId || null,
      metadata: opts.metadata || null,
    });
  } catch (err) {
    console.error('Не удалось записать лог активности:', err);
  }
}

async function notifyManagers(adminClient, client, reason) {
  try {
    const { data: assignedManager } = await adminClient
      .from('clients')
      .select('assigned_to')
      .eq('id', client.id)
      .single();

    const { data: task } = await adminClient.from('tasks').insert({
      client_id: client.id,
      title: `🤖 AI передал диалог: ${client.full_name || 'клиент'} — ${reason || 'требуется внимание'}`,
      assigned_to: assignedManager?.assigned_to || null,
      due_at: new Date().toISOString(),
      priority: 'high',
    }).select().single();

    await adminClient.from('notifications').insert({
      type: 'ai_escalated',
      title: `AI передал диалог: ${client.full_name || 'клиент'}`,
      client_id: client.id,
      task_id: task?.id || null,
    });
  } catch (err) {
    console.error('Не удалось создать уведомление-задачу для менеджера:', err);
  }
}

async function createOrUpdateDealFromAi(adminClient, clientId, dealInfo, products, requestedStageName) {
  const matchedProduct = products.find((p) =>
    p.name.toLowerCase().includes(dealInfo.product_name.toLowerCase()) ||
    dealInfo.product_name.toLowerCase().includes(p.name.toLowerCase())
  );

  // Ищем уже существующую открытую (не закрытую) сделку этого клиента — чтобы не плодить дубли
  const { data: existingDeal } = await adminClient
    .from('deals')
    .select('*, pipeline_stages(is_won,is_lost)')
    .eq('client_id', clientId)
    .is('closed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: allStages } = await adminClient.from('pipeline_stages').select('*').order('sort_order');
  const firstStage = allStages?.[0];
  const targetStage = requestedStageName
    ? allStages?.find((s) => s.name.toLowerCase() === requestedStageName.toLowerCase())
    : null;

  let deal = existingDeal;

  if (!deal) {
    const { data: newDeal, error: dealError } = await adminClient
      .from('deals')
      .insert({
        client_id: clientId,
        stage_id: targetStage?.id || firstStage?.id,
        title: `${dealInfo.product_name}${dealInfo.size ? ' ' + dealInfo.size : ''}`,
        amount: dealInfo.price * (dealInfo.qty || 1),
        assigned_to: null,
      })
      .select()
      .single();

    if (dealError || !newDeal) {
      console.error('Ошибка создания сделки AI-агентом:', dealError);
      return;
    }
    deal = newDeal;

    if (matchedProduct) {
      await adminClient.from('deal_items').insert({
        deal_id: deal.id,
        product_id: matchedProduct.id,
        qty: dealInfo.qty || 1,
        price: dealInfo.price,
      });
    }

    await adminClient.from('interactions').insert({
      client_id: clientId,
      deal_id: deal.id,
      type: 'ai_action',
      content: `AI-агент создал сделку: ${dealInfo.product_name} ${dealInfo.size || ''} на сумму ${dealInfo.price * (dealInfo.qty || 1)} сом`,
    });
  } else if (targetStage && targetStage.id !== deal.stage_id) {
    // Сделка уже существует — просто двигаем её на нужный этап, если AI определил прогресс в разговоре
    const updates = { stage_id: targetStage.id, updated_at: new Date().toISOString() };
    if (targetStage.is_won || targetStage.is_lost) updates.closed_at = new Date().toISOString();

    await adminClient.from('deals').update(updates).eq('id', deal.id);

    await adminClient.from('interactions').insert({
      client_id: clientId,
      deal_id: deal.id,
      type: 'ai_action',
      content: `AI переместил сделку на этап: ${targetStage.name}`,
    });

    // Если сделка выиграна — создаём заказ автоматически (как и в обычном ручном перемещении)
    if (targetStage.is_won) {
      const { data: existingOrder } = await adminClient.from('orders').select('id').eq('deal_id', deal.id).maybeSingle();
      if (!existingOrder) {
        const { data: orderNumberData } = await adminClient.rpc('generate_order_number');
        await adminClient.from('orders').insert({
          deal_id: deal.id,
          client_id: clientId,
          order_number: orderNumberData || `OS-${Date.now()}`,
          total_amount: deal.amount,
        });
      }
    }
  }
}

// ============================================
// ОСНОВНОЙ ОБРАБОТЧИК
// ============================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json();
    const { client_id } = body;
    if (!client_id) {
      return json({ success: false, error: 'Укажи client_id' }, 400);
    }

    const context = await buildContext(adminClient, client_id);

    if (!context.client) {
      return json({ success: false, error: 'Клиент не найден' }, 404);
    }

    if (!context.settings?.is_enabled || !context.settings?.auto_reply_enabled) {
      return json({ success: true, skipped: 'AI-агент выключен глобально' });
    }
    if (context.client.ai_managed === false) {
      return json({ success: true, skipped: 'Для этого клиента AI отключён вручную' });
    }
    if (context.client.conversation_owner === 'human') {
      return json({ success: true, skipped: 'Диалог сейчас ведёт менеджер — AI ждёт явного возврата' });
    }

    const systemPrompt = buildSystemPrompt(context);

    const claudeMessages = context.history
      .filter((m) => m.content)
      .map((m) => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.content,
      }));

    if (!claudeMessages.length || claudeMessages[claudeMessages.length - 1].role !== 'user') {
      return json({ success: true, skipped: 'Нет нового сообщения от клиента для ответа' });
    }

    const aiResult = await callClaude(systemPrompt, claudeMessages);

    // Сохраняем статистику токенов
    if (aiResult._usage) {
      const inputTokens = aiResult._usage.input_tokens || 0;
      const outputTokens = aiResult._usage.output_tokens || 0;
      const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
      try {
        await adminClient.from('ai_usage_stats').insert({
          client_id,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cost_usd: costUsd,
          model: CLAUDE_MODEL,
          function_name: 'ai-agent',
        });
      } catch (e) {
        console.log('ai_usage_stats не сохранено:', e);
      }
    }
    delete aiResult._usage;

    if (aiResult.needs_human) {
      const lastInboundMessage = [...context.history].reverse().find((m) => m.direction === 'inbound');
      if (lastInboundMessage) {
        await adminClient.from('messages').update({ needs_human_review: true }).eq('id', lastInboundMessage.id);
      }
      await adminClient.from('clients').update({ conversation_owner: 'human' }).eq('id', client_id);
      await adminClient.from('interactions').insert({
        client_id,
        type: 'ai_action',
        content: `AI передал диалог менеджеру. Причина: ${aiResult.escalation_reason || 'не указана'}`,
      });
      await logActivity(adminClient, 'ai', 'ai_escalated', `AI передал диалог менеджеру: ${context.client.full_name || 'клиент'} — ${aiResult.escalation_reason || 'не указана причина'}`, { clientId: client_id });
      await notifyManagers(adminClient, context.client, aiResult.escalation_reason);
      return json({ success: true, escalated: true, reason: aiResult.escalation_reason });
    }

    const sendResult = await sendReplyThroughChannel(adminClient, context.client, aiResult.reply);
    if (!sendResult.success) {
      console.error('Не удалось отправить ответ AI клиенту:', sendResult.error);
      await logActivity(adminClient, 'error', 'ai_send_failed', `Не удалось отправить ответ AI клиенту ${context.client.full_name || ''}: ${sendResult.error}`, { clientId: client_id });
      return json({ success: false, error: sendResult.error }, 500);
    }

    await logActivity(adminClient, 'ai', 'ai_replied', `AI ответил клиенту ${context.client.full_name || ''}`, { clientId: client_id });

    if (aiResult.create_deal && aiResult.deal_info) {
      await createOrUpdateDealFromAi(adminClient, client_id, aiResult.deal_info, context.products, aiResult.deal_info.stage_name);
    }

    // Отправляем фото если AI указал товар
    if (aiResult.send_photo) {
      const photoHint = String(aiResult.send_photo).toLowerCase().trim();
      let mentionedProduct = null;

      // 1. Точное совпадение по ID
      const productById = context.products.find(p => String(p.id) === photoHint);
      if (productById) mentionedProduct = productById;

      // 2. Точное совпадение по ключевому слову названия (sultan/rayana/marva)
      if (!mentionedProduct) {
        mentionedProduct = context.products.find(p => {
          const nameLower = (p.name || '').toLowerCase();
          return nameLower.includes(photoHint) || photoHint.includes(nameLower.split(' ').find(w => w.length > 3) || '');
        });
      }

      // 3. Ищем ключевое слово в ответе AI
      if (!mentionedProduct) {
        const aiReplyLower = (aiResult.reply || '').toLowerCase();
        mentionedProduct = context.products.find(p => {
          const keyword = (p.name || '').toLowerCase().split(' ').find(w => w.length > 3);
          return keyword && aiReplyLower.includes(keyword);
        });
      }

      if (mentionedProduct?.photo_url) {
        const photoText = `📸 ${mentionedProduct.name}:\n${mentionedProduct.photo_url}`;
        await sendReplyThroughChannel(adminClient, context.client, photoText);
        console.log(`Отправлено фото: ${mentionedProduct.name} (id=${mentionedProduct.id})`);
        await adminClient.from('messages').insert({
          client_id,
          channel_id: context.client.primary_channel_id,
          direction: 'outbound',
          sender: 'ai_agent',
          content: photoText,
          is_read: true,
        });
      } else if (mentionedProduct) {
        console.log(`Товар найден (${mentionedProduct.name}) но нет photo_url`);
      } else {
        console.log(`Товар не найден для send_photo="${aiResult.send_photo}"`);
      }
    }

    if (aiResult.schedule_followup && aiResult.schedule_followup.minutes_from_now) {
      const dueAt = new Date(Date.now() + aiResult.schedule_followup.minutes_from_now * 60 * 1000);
      const { data: assignedManager } = await adminClient.from('clients').select('assigned_to').eq('id', client_id).single();

      await adminClient.from('tasks').insert({
        client_id,
        title: `Связаться с клиентом по его просьбе: ${context.client.full_name || 'клиент'} — ${aiResult.schedule_followup.note || 'просил написать позже'}`,
        assigned_to: assignedManager?.assigned_to || null,
        due_at: dueAt.toISOString(),
        priority: 'normal',
      });

      await adminClient.from('interactions').insert({
        client_id,
        type: 'ai_action',
        content: `AI запланировал напоминание: ${aiResult.schedule_followup.note || ''} (через ${aiResult.schedule_followup.minutes_from_now} мин)`,
      });
    }

    // Автоматически обновляем карточку клиента если AI извлёк данные из разговора
    const clientUpdates: Record<string, any> = { ai_last_followup_at: new Date().toISOString() };
    if (aiResult.update_client) {
      const uc = aiResult.update_client;
      if (uc.phone && !context.client.phone) clientUpdates.phone = uc.phone;
      if (uc.city && !context.client.city) clientUpdates.city = uc.city;
      if (uc.lead_status) clientUpdates.lead_status = uc.lead_status;
      if (Object.keys(uc).length > 0) {
        await adminClient.from('interactions').insert({
          client_id,
          type: 'ai_action',
          content: `AI обновил карточку клиента: ${JSON.stringify(uc)}`,
        });
      }
    }
    await adminClient.from('clients').update(clientUpdates).eq('id', client_id);

    return json({ success: true, replied: true });
  } catch (err) {
    console.error('Ошибка в AI-агенте:', err);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const errorLogClient = createClient(supabaseUrl, serviceRoleKey);
      await errorLogClient.from('activity_logs').insert({
        category: 'error',
        action: 'ai_agent_error',
        description: `Ошибка в AI-агенте: ${String(err)}`,
      });
    } catch (logErr) {
      console.error('Не удалось записать ошибку в лог:', logErr);
    }
    return json({ success: false, error: String(err) }, 500);
  }
});
