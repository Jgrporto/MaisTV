import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectChatbotFlowWinner,
  simulateChatbotFlow,
} from './chatbot-engine.service.mjs';
import { normalizeChatbotInboundValues } from './chatbot-postgres-runtime.service.mjs';

const flow = (overrides = {}) => ({
  id: overrides.id || 'flow-default',
  tenantId: 'maistv',
  routeKey: overrides.routeKey ?? 'vendas',
  status: 'published',
  isActive: true,
  priority: overrides.priority ?? 100,
  version: overrides.version ?? 1,
  updatedAt: overrides.updatedAt || '2026-07-01T00:00:00.000Z',
  triggerConfig: overrides.triggerConfig || { rule: 'contains', triggerValue: '#teste' },
  definition: overrides.definition || { state: { nodes: [], edges: [] } },
});

test('seleciona apenas um fluxo por prioridade antes da especificidade', () => {
  const selection = selectChatbotFlowWinner([
    flow({ id: 'specific', priority: 20, triggerConfig: { rule: 'equals', triggerValue: '#testeBot' } }),
    flow({ id: 'priority', priority: 10, triggerConfig: { rule: 'contains', triggerValue: '#teste' } }),
  ], '#testeBot', 'vendas');
  assert.equal(selection.winner.id, 'priority');
  assert.equal(selection.candidates.length, 2);
  assert.equal(selection.candidates.filter((candidate) => candidate.selected).length, 1);
});

test('desempata por gatilho especifico e rota exata', () => {
  const selection = selectChatbotFlowWinner([
    flow({ id: 'generic', routeKey: null, triggerConfig: { rule: 'contains', triggerValue: '#teste' } }),
    flow({ id: 'exact-route', triggerConfig: { rule: 'equals', triggerValue: '#testeBot' } }),
  ], '#testeBot', 'vendas');
  assert.equal(selection.winner.id, 'exact-route');
});

test('normaliza texto, button e interactive reply sem perder ids', () => {
  const normalized = normalizeChatbotInboundValues({
    body: 'TV',
    raw_json: {
      button: { text: 'TV', payload: 'tv-payload' },
      interactive: {
        button_reply: { title: 'TV', id: 'edge-tv' },
        list_reply: { title: 'Celular', id: 'edge-celular' },
      },
    },
  });
  assert.deepEqual(normalized.values, ['TV', 'tv-payload', 'edge-tv', 'Celular', 'edge-celular']);
  assert.ok(normalized.normalizedValues.includes('tv'));
  assert.ok(normalized.normalizedValues.includes('edge-celular'));
});

test('planeja mensagem de boas-vindas antes da pergunta e da URA', () => {
  const definition = {
    state: {
      nodes: [
        { id: 'chatbot-start', data: { componentType: 'start' } },
        { id: 'welcome', data: { componentType: 'message', text: 'Seja bem vindo!' } },
        { id: 'question', data: { componentType: 'message', text: 'Voce quer falar com qual setor' } },
        { id: 'ura', data: { componentType: 'ura', text: 'Escolha', displayAs: 'buttons' } },
        { id: 'tv', data: { componentType: 'message', text: 'TV selecionada' } },
        { id: 'mobile', data: { componentType: 'message', text: 'Celular selecionado' } },
      ],
      edges: [
        { id: 'start-welcome', source: 'chatbot-start', target: 'welcome' },
        { id: 'welcome-question', source: 'welcome', target: 'question' },
        { id: 'question-ura', source: 'question', target: 'ura' },
        { id: 'edge-tv', source: 'ura', target: 'tv', data: { connectionType: 'option', description: 'TV' } },
        { id: 'edge-mobile', source: 'ura', target: 'mobile', data: { connectionType: 'option', description: 'Celular' } },
      ],
    },
  };
  const plan = simulateChatbotFlow({
    flow: flow({ definition }),
    conversation: { last_message: '#testeBot' },
  });
  assert.deepEqual(plan.outputs.map((output) => output.type), ['text', 'text', 'interactive']);
  assert.equal(plan.outputs[0].text, 'Seja bem vindo!');
  assert.equal(plan.outputs[1].text, 'Voce quer falar com qual setor');
  assert.deepEqual(plan.outputs[2].options.map((option) => option.title), ['TV', 'Celular']);
  assert.equal(plan.nextState.status, 'awaiting_ura');
});
