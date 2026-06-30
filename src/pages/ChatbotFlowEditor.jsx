import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '@fortawesome/fontawesome-free/css/all.min.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Plus, Save, Trash2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';

import LabelBadge from '@/components/labels/LabelBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { fetchServices } from '@/lib/services-api';
import {
  CHATBOT_START_NODE_ID,
  CHATBOT_VARIABLES,
  downloadTextFile,
  ensureStartNode,
  exportChatbotFlowJson,
  getChatbotFlow,
  normalizeFlowState,
  updateChatbotFlow,
  uploadChatbotAsset,
} from '@/lib/chatbot-flows-api';
import { SYSTEM_LABELS, useLabelCatalog } from '@/lib/labels';
import { cn } from '@/lib/utils';

const COMPONENTS = [
  { type: 'start', label: 'Inicio', icon: 'fa-solid fa-robot', prefix: 'inicio', color: '#111827', locked: true },
  { type: 'message', label: 'Mensagem', icon: 'fa-solid fa-comment-dots', prefix: 'mensagem', color: '#2563EB' },
  { type: 'audio', label: 'Audio', icon: 'fa-solid fa-microphone-lines', prefix: 'audio', color: '#0891B2' },
  { type: 'label', label: 'Etiqueta', icon: 'fa-solid fa-tag', prefix: 'etiqueta', color: '#16A34A' },
  { type: 'finish', label: 'Finalizacao', icon: 'fa-solid fa-flag-checkered', prefix: 'finalizacao', color: '#DC2626' },
  { type: 'service', label: 'Serviço', icon: 'fa-solid fa-user-astronaut', prefix: 'servico', color: '#64748B', disabled: true },
  { type: 'ura', label: 'URA', icon: 'fa-solid fa-sitemap', prefix: 'ura', color: '#7C3AED' },
  { type: 'variables', label: 'Setar Variaveis', icon: 'fa-solid fa-toolbox', prefix: 'variaveis', color: '#D97706' },
  { type: 'schedule', label: 'Horario', icon: 'fa-solid fa-alarm-clock', prefix: 'horario', color: '#64748B', disabled: true },
  { type: 'redirect', label: 'Redirecionar', icon: 'fa-solid fa-shuffle', prefix: 'red', color: '#0F766E' },
  { type: 'code', label: 'Code', icon: 'fa-solid fa-code', prefix: 'code', color: '#64748B', disabled: true },
  { type: 'wait', label: 'Espera', icon: 'fa-solid fa-hourglass-half', prefix: 'wait', color: '#EA580C' },
];

const COMPONENTS_BY_TYPE = new Map(COMPONENTS.map((item) => [item.type, item]));
const EDGE_TYPES = [
  ['option', 'Opcao'],
  ['invalid', 'Invalido'],
  ['timeout', 'Tempo de Espera'],
];

const START_RULES = [
  ['contains', 'Contem'],
  ['not_equal', 'Diferente de'],
  ['equals', 'Igual a'],
  ['gte', 'Maior ou igual a'],
  ['gt', 'Maior que'],
  ['lte', 'Menor ou igual a'],
  ['lt', 'Menor que'],
];

const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Nao foi possivel ler o arquivo selecionado.'));
    reader.readAsDataURL(file);
  });

const buildDirtySnapshot = ({ name, nodes, edges }) =>
  JSON.stringify({
    name: String(name || '').trim(),
    nodes: normalizeFlowState({ nodes, edges }).nodes,
    edges: normalizeFlowState({ nodes, edges }).edges,
  });

const flowMatchesRef = (flow, flowRef = '') => {
  const safeRef = decodeURIComponent(String(flowRef || '').trim());
  const code = String(flow?.code || '').trim();
  return (
    String(flow?.id || '') === safeRef ||
    code === safeRef ||
    (code && `flow${code}` === safeRef) ||
    (code && `flow-${code}` === safeRef)
  );
};

const buildNodeName = (type, nodes) => {
  const meta = COMPONENTS_BY_TYPE.get(type) || COMPONENTS[0];
  const count = nodes.filter((node) => node.data?.componentType === type).length + 1;
  return `${meta.prefix}_${count}`;
};

const createNodeData = (type, nodes) => {
  const name = buildNodeName(type, nodes);
  const base = {
    componentType: type,
    name,
  };

  if (type === 'start') return { componentType: 'start', name: 'inicio fluxo', rule: 'contains', triggerValue: '' };
  if (type === 'message') return { ...base, headerType: 'none', text: '' };
  if (type === 'audio') return { ...base, audioName: '', audioAsset: null };
  if (type === 'label') return { ...base, addLabelId: '', removeLabelId: '', removeAllCustom: false };
  if (type === 'finish') return { ...base, finishType: 'resolved', surveyId: 'none' };
  if (type === 'ura') return { ...base, text: '', waitMinutes: 5, displayAs: 'buttons', listTitle: 'MENU' };
  if (type === 'variables') return { ...base, variables: [] };
  if (type === 'redirect') return { ...base, destinationNodeId: '' };
  if (type === 'wait') return { ...base, waitSeconds: 3 };
  return base;
};

const getNodeLabel = (node) => {
  const meta = COMPONENTS_BY_TYPE.get(node?.data?.componentType) || COMPONENTS[0];
  return node?.data?.name || meta.label;
};

function ChatbotNode({ data, selected }) {
  const meta = COMPONENTS_BY_TYPE.get(data.componentType) || COMPONENTS[0];
  const isStart = data.componentType === 'start';

  return (
    <div
      className={cn(
        'min-w-[190px] rounded-2xl border bg-card px-4 py-3 shadow-[0_12px_35px_rgba(15,23,42,0.12)]',
        selected ? 'border-primary ring-4 ring-primary/10' : 'border-border',
      )}
    >
      {!isStart ? <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-background !bg-primary" /> : null}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ backgroundColor: meta.color }}>
          <i className={meta.icon} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{data.name || meta.label}</div>
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{meta.label}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-background !bg-primary" />
    </div>
  );
}

const nodeTypes = { chatbotNode: ChatbotNode };

function FieldLabel({ children }) {
  return <label className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{children}</label>;
}

function PropertyPanel({
  selectedNode,
  selectedEdge,
  nodes,
  edges,
  customLabels,
  onNodeChange,
  onDeleteNode,
  onEdgeChange,
  onDeleteEdge,
  onAssetUpload,
}) {
  const customLabelOptions = customLabels.filter((label) => !SYSTEM_LABELS.some((systemLabel) => systemLabel.id === label.id));
  const selectedNodeMeta = COMPONENTS_BY_TYPE.get(selectedNode?.data?.componentType);
  const edgeSourceNode = selectedEdge ? nodes.find((node) => node.id === selectedEdge.source) : null;
  const canEditUraEdge = edgeSourceNode?.data?.componentType === 'ura';

  if (!selectedNode && !selectedEdge) {
    return (
      <aside className="w-[360px] flex-shrink-0 border-l border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Propriedades</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Selecione um componente ou uma seta para configurar o comportamento do flow.
        </p>
      </aside>
    );
  }

  if (selectedEdge) {
    return (
      <aside className="nodrag nopan w-[360px] flex-shrink-0 overflow-y-auto border-l border-border bg-card p-5" onPointerDownCapture={(event) => event.stopPropagation()}>
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Seta do fluxo</h2>
            <p className="text-xs text-muted-foreground">{getNodeLabel(edgeSourceNode)} para {getNodeLabel(nodes.find((node) => node.id === selectedEdge.target))}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onDeleteEdge(selectedEdge.id)}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>

        {canEditUraEdge ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <FieldLabel>Tipo de Ligacao</FieldLabel>
              <Select value={selectedEdge.data?.connectionType || 'option'} onValueChange={(value) => onEdgeChange(selectedEdge.id, { connectionType: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EDGE_TYPES.map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {(selectedEdge.data?.connectionType || 'option') === 'option' ? (
              <div className="space-y-2">
                <FieldLabel>Descricao</FieldLabel>
                <Input value={selectedEdge.data?.description || ''} onChange={(event) => onEdgeChange(selectedEdge.id, { description: event.target.value })} placeholder="Ex.: Segunda via" />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="rounded-2xl border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            Somente setas que saem de uma URA possuem tipo de ligacao configuravel.
          </p>
        )}
      </aside>
    );
  }

  const data = selectedNode.data || {};

  return (
    <aside className="nodrag nopan w-[380px] flex-shrink-0 overflow-y-auto border-l border-border bg-card p-5" onPointerDownCapture={(event) => event.stopPropagation()}>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{selectedNodeMeta?.label || 'Componente'}</h2>
          <p className="text-xs text-muted-foreground">Configure os dados enviados por este bloco.</p>
        </div>
        {data.componentType !== 'start' ? (
          <Button variant="ghost" size="icon" onClick={() => onDeleteNode(selectedNode.id)}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        ) : null}
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <FieldLabel>Nome do Componente</FieldLabel>
          <Input value={data.name || ''} onChange={(event) => onNodeChange(selectedNode.id, { name: event.target.value })} />
        </div>

        {data.componentType === 'start' ? (
          <>
            <div className="space-y-2">
              <FieldLabel>Regras</FieldLabel>
              <Select value={data.rule || 'contains'} onValueChange={(value) => onNodeChange(selectedNode.id, { rule: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {START_RULES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <FieldLabel>Valor</FieldLabel>
              <Input value={data.triggerValue || ''} onChange={(event) => onNodeChange(selectedNode.id, { triggerValue: event.target.value })} placeholder="Ex.: oi, suporte, renovar" />
            </div>
          </>
        ) : null}

        {data.componentType === 'message' ? (
          <>
            <div className="space-y-2">
              <FieldLabel>Header</FieldLabel>
              <Select value={data.headerType || 'none'} onValueChange={(value) => onNodeChange(selectedNode.id, { headerType: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem header</SelectItem>
                  <SelectItem value="image">Imagem</SelectItem>
                  <SelectItem value="video">Video</SelectItem>
                  <SelectItem value="document">Documento</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {data.headerType && data.headerType !== 'none' ? (
              <MediaUploadField
                label={`Upload de ${data.headerType === 'image' ? 'imagem' : data.headerType === 'video' ? 'video' : 'documento'}`}
                accept={data.headerType === 'image' ? 'image/*' : data.headerType === 'video' ? 'video/*' : '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,application/*'}
                asset={data.headerAsset}
                kind={data.headerType}
                onUpload={async (file) => {
                  const asset = await onAssetUpload(file, data.headerType);
                  onNodeChange(selectedNode.id, { headerAsset: asset });
                }}
              />
            ) : null}
            <div className="space-y-2">
              <FieldLabel>Texto</FieldLabel>
              <Textarea value={data.text || ''} onChange={(event) => onNodeChange(selectedNode.id, { text: event.target.value })} className="min-h-[160px]" placeholder="Mensagem que sera enviada ao cliente." />
            </div>
          </>
        ) : null}

        {data.componentType === 'audio' ? (
          <MediaUploadField
            label="Upload do audio"
            accept="audio/*"
            asset={data.audioAsset}
            kind="audio"
            onUpload={async (file) => {
              const asset = await onAssetUpload(file, 'audio');
              onNodeChange(selectedNode.id, { audioName: asset.fileName, audioAsset: asset });
            }}
          />
        ) : null}

        {data.componentType === 'label' ? (
          <>
            <div className="space-y-2">
              <FieldLabel>Remover etiqueta</FieldLabel>
              <Select value={data.removeLabelId || 'none'} onValueChange={(value) => onNodeChange(selectedNode.id, { removeLabelId: value === 'none' ? '' : value })}>
                <SelectTrigger><SelectValue placeholder="Selecionar etiqueta" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhuma</SelectItem>
                  {customLabelOptions.map((label) => <SelectItem key={label.id} value={label.id}>{label.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <input type="checkbox" checked={Boolean(data.removeAllCustom)} onChange={(event) => onNodeChange(selectedNode.id, { removeAllCustom: event.target.checked })} />
              Remover todas as etiquetas personalizadas
            </label>
            <div className="space-y-2">
              <FieldLabel>Adicionar etiqueta</FieldLabel>
              <Select value={data.addLabelId || 'none'} onValueChange={(value) => onNodeChange(selectedNode.id, { addLabelId: value === 'none' ? '' : value })}>
                <SelectTrigger><SelectValue placeholder="Selecionar etiqueta" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhuma</SelectItem>
                  {customLabelOptions.map((label) => <SelectItem key={label.id} value={label.id}>{label.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </>
        ) : null}

        {data.componentType === 'finish' ? (
          <>
            <div className="space-y-2">
              <FieldLabel>Tipo de Finalizacao</FieldLabel>
              <Select value={data.finishType || 'resolved'} onValueChange={(value) => onNodeChange(selectedNode.id, { finishType: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="resolved">Resolvido</SelectItem>
                  <SelectItem value="no_interaction">Falta de Interacao</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <FieldLabel>Pesquisa de Satisfacao</FieldLabel>
              <Select value={data.surveyId || 'none'} onValueChange={(value) => onNodeChange(selectedNode.id, { surveyId: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nao Enviar</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        ) : null}

        {data.componentType === 'ura' ? (
          <>
            <div className="space-y-2">
              <FieldLabel>Texto da mensagem</FieldLabel>
              <Textarea
                value={data.text || ''}
                onChange={(event) => onNodeChange(selectedNode.id, { text: event.target.value })}
                className="min-h-[120px]"
                placeholder="Mensagem que sera enviada junto das opcoes da URA."
              />
            </div>
            <div className="space-y-2">
              <FieldLabel>Tempo de Espera em minutos</FieldLabel>
              <Input type="number" min="1" value={data.waitMinutes || 1} onChange={(event) => onNodeChange(selectedNode.id, { waitMinutes: Number(event.target.value || 1) })} />
            </div>
            <div className="space-y-2">
              <FieldLabel>Exibir opcoes em</FieldLabel>
              <Select value={data.displayAs || 'buttons'} onValueChange={(value) => onNodeChange(selectedNode.id, { displayAs: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Texto</SelectItem>
                  <SelectItem value="buttons">Botoes</SelectItem>
                  <SelectItem value="list">Lista</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {data.displayAs === 'list' ? (
              <div className="space-y-2">
                <FieldLabel>Titulo da lista</FieldLabel>
                <Input value={data.listTitle || 'MENU'} onChange={(event) => onNodeChange(selectedNode.id, { listTitle: event.target.value || 'MENU' })} />
              </div>
            ) : null}
          </>
        ) : null}

        {data.componentType === 'variables' ? (
          <VariablesEditor data={data} onChange={(patch) => onNodeChange(selectedNode.id, patch)} />
        ) : null}

        {data.componentType === 'redirect' ? (
          <div className="space-y-2">
            <FieldLabel>Destino</FieldLabel>
            <Select value={data.destinationNodeId || 'none'} onValueChange={(value) => onNodeChange(selectedNode.id, { destinationNodeId: value === 'none' ? '' : value })}>
              <SelectTrigger><SelectValue placeholder="Selecionar destino" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nenhum</SelectItem>
                {nodes.filter((node) => node.id !== selectedNode.id).map((node) => (
                  <SelectItem key={node.id} value={node.id}>{getNodeLabel(node)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {data.componentType === 'wait' ? (
          <div className="space-y-2">
            <FieldLabel>Tempo Espera em segundos</FieldLabel>
            <Input type="number" min="1" value={data.waitSeconds || 1} onChange={(event) => onNodeChange(selectedNode.id, { waitSeconds: Number(event.target.value || 1) })} />
          </div>
        ) : null}

        {data.componentType === 'label' && customLabelOptions.length ? (
          <div className="rounded-2xl border border-border bg-muted/20 p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Etiquetas disponiveis</p>
            <div className="flex flex-wrap gap-1.5">
              {customLabelOptions.slice(0, 8).map((label) => <LabelBadge key={label.id} label={label} compact />)}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function MediaUploadField({ label, accept, asset, kind, onUpload }) {
  const [isUploading, setIsUploading] = useState(false);

  const handleChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setIsUploading(true);
    try {
      await onUpload(file);
      toast.success('Arquivo enviado para a VPS.');
    } catch (error) {
      toast.error(error?.message || 'Falha ao enviar arquivo.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <FieldLabel>{label}</FieldLabel>
      <Input type="file" accept={accept} onChange={handleChange} disabled={isUploading} />
      {asset?.fileName ? <p className="text-xs text-muted-foreground">Arquivo: {asset.fileName}</p> : null}
      {asset?.dataUrl && kind === 'image' ? <img src={asset.dataUrl} alt={asset.fileName || 'Preview'} className="max-h-36 rounded-xl border border-border object-contain" /> : null}
      {asset?.dataUrl && kind === 'video' ? <video src={asset.dataUrl} controls className="max-h-40 w-full rounded-xl border border-border" /> : null}
      {asset?.dataUrl && kind === 'audio' ? <audio src={asset.dataUrl} controls className="w-full" /> : null}
      {asset?.dataUrl && kind === 'document' ? (
        <a className="text-sm font-medium text-primary underline" href={asset.dataUrl} target="_blank" rel="noreferrer">
          Abrir preview do documento
        </a>
      ) : null}
    </div>
  );
}

function VariablesEditor({ data, onChange }) {
  const variables = Array.isArray(data.variables) ? data.variables : [];

  const updateVariable = (index, patch) => {
    onChange({
      variables: variables.map((variable, currentIndex) => (currentIndex === index ? { ...variable, ...patch } : variable)),
    });
  };

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-border bg-muted/20 p-3">
        <p className="text-xs font-medium text-muted-foreground">Variaveis padroes disponiveis</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CHATBOT_VARIABLES.map((variable) => (
            <span key={variable.key} className="rounded-full bg-background px-2 py-1 text-[11px] font-semibold text-primary">
              {variable.key}
            </span>
          ))}
        </div>
      </div>

      {variables.map((variable, index) => (
        <div key={variable.id || `variable-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Input value={variable.key || ''} onChange={(event) => updateVariable(index, { key: event.target.value })} placeholder="nome_variavel" />
          <Input value={variable.value || ''} onChange={(event) => updateVariable(index, { value: event.target.value })} placeholder="Valor" />
          <Button variant="ghost" size="icon" onClick={() => onChange({ variables: variables.filter((_, currentIndex) => currentIndex !== index) })}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ))}

      <Button type="button" variant="outline" className="w-full" onClick={() => onChange({ variables: [...variables, { id: `var-${Date.now().toString(36)}`, key: '', value: '' }] })}>
        <Plus className="h-4 w-4" />
        Adicionar variavel
      </Button>
    </div>
  );
}

function ChatbotFlowEditorCanvas() {
  const { flowRef } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { customLabels } = useLabelCatalog();
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [flowName, setFlowName] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const lastSavedSnapshotRef = useRef('');

  useQuery({ queryKey: ['services', 'chatbot-editor'], queryFn: fetchServices, staleTime: 10000 });

  const { data: flow, isLoading } = useQuery({
    queryKey: ['chatbot-flow', flowRef],
    queryFn: () => getChatbotFlow(flowRef),
    enabled: Boolean(flowRef),
    initialData: () => {
      const cachedFlows = queryClient.getQueryData(['chatbot-flows']);
      const cachedFlow = Array.isArray(cachedFlows) ? cachedFlows.find((item) => flowMatchesRef(item, flowRef)) : undefined;
      return cachedFlow?.state ? cachedFlow : undefined;
    },
  });

  useEffect(() => {
    if (!flow) return;
    const normalizedState = normalizeFlowState(flow.state);
    setFlowName(flow.name);
    setNodes(normalizedState.nodes || []);
    setEdges(normalizedState.edges || []);
    lastSavedSnapshotRef.current = buildDirtySnapshot({
      name: flow.name,
      nodes: normalizedState.nodes || [],
      edges: normalizedState.edges || [],
    });
  }, [flow, setEdges, setNodes]);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) || null, [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find((edge) => edge.id === selectedEdgeId) || null, [edges, selectedEdgeId]);
  const currentSnapshot = useMemo(
    () => buildDirtySnapshot({ name: flowName, nodes, edges }),
    [edges, flowName, nodes],
  );
  const hasUnsavedChanges = Boolean(flow) && lastSavedSnapshotRef.current && currentSnapshot !== lastSavedSnapshotRef.current;

  const saveMutation = useMutation({
    mutationFn: (payload) => updateChatbotFlow(flow.id, payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ['chatbot-flow', flowRef] });
      await queryClient.cancelQueries({ queryKey: ['chatbot-flows'] });

      const previousFlow = queryClient.getQueryData(['chatbot-flow', flowRef]);
      const previousFlows = queryClient.getQueryData(['chatbot-flows']);
      const previousSavedSnapshot = lastSavedSnapshotRef.current;
      const optimisticFlow = {
        ...flow,
        ...payload,
        updated_date: new Date().toISOString(),
      };
      const nextSnapshot = buildDirtySnapshot({
        name: optimisticFlow.name,
        nodes: optimisticFlow.state.nodes || [],
        edges: optimisticFlow.state.edges || [],
      });

      lastSavedSnapshotRef.current = nextSnapshot;
      queryClient.setQueryData(['chatbot-flow', flowRef], optimisticFlow);
      queryClient.setQueryData(['chatbot-flows'], (current = []) =>
        Array.isArray(current) ? current.map((item) => (item.id === optimisticFlow.id ? optimisticFlow : item)) : current,
      );

      return { previousFlow, previousFlows, previousSavedSnapshot };
    },
    onSuccess: (savedFlow) => {
      queryClient.setQueryData(['chatbot-flow', flowRef], savedFlow);
      queryClient.setQueryData(['chatbot-flows'], (current = []) =>
        Array.isArray(current) ? current.map((item) => (item.id === savedFlow.id ? savedFlow : item)) : current,
      );
      lastSavedSnapshotRef.current = buildDirtySnapshot({
        name: savedFlow.name,
        nodes: savedFlow.state.nodes || [],
        edges: savedFlow.state.edges || [],
      });
      toast.success('Flow salvo com sucesso.');
      queryClient.invalidateQueries({ queryKey: ['chatbot-flows'] });
    },
    onError: (error, _payload, context) => {
      if (context?.previousFlow) {
        queryClient.setQueryData(['chatbot-flow', flowRef], context.previousFlow);
      }
      if (context?.previousFlows) {
        queryClient.setQueryData(['chatbot-flows'], context.previousFlows);
      }
      lastSavedSnapshotRef.current = context?.previousSavedSnapshot || '';
      toast.error(error?.message || 'Nao foi possivel salvar o flow.');
    },
  });

  const buildSavePayload = () => ({
    name: flowName || flow.name,
    active: flow.active,
    state: normalizeFlowState({
        nodes,
        edges,
        viewport: reactFlowInstance?.getViewport?.() || flow.state.viewport,
    }),
  });

  const uploadAssetMutation = useMutation({
    mutationFn: async ({ file, kind }) => {
      const dataUrl = await readFileAsDataUrl(file);
      return uploadChatbotAsset({
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataUrl,
        kind,
      });
    },
  });

  const addNode = (type, position = null) => {
    const meta = COMPONENTS_BY_TYPE.get(type);
    if (!meta || meta.disabled || meta.locked) return;

    const id = `${type}-${Date.now().toString(36)}`;
    const nodePosition = position || reactFlowInstance?.screenToFlowPosition?.({ x: window.innerWidth / 2, y: 220 }) || {
      x: 140 + nodes.length * 24,
      y: 140 + nodes.length * 24,
    };

    const nextNode = {
      id,
      type: 'chatbotNode',
      position: nodePosition,
      data: createNodeData(type, nodes),
    };

    setNodes((current) => [...current, nextNode]);
    setSelectedNodeId(id);
    setSelectedEdgeId('');
  };

  const canUseUraConnectionType = (sourceNodeId, connectionType, edgeId = '') => {
    const sourceEdges = edges.filter((edge) => edge.source === sourceNodeId && edge.id !== edgeId);
    if (connectionType === 'option') {
      return sourceEdges.filter((edge) => (edge.data?.connectionType || 'option') === 'option').length < 10;
    }
    return !sourceEdges.some((edge) => edge.data?.connectionType === connectionType);
  };

  const onConnect = useCallback((connection) => {
    const sourceNode = nodes.find((node) => node.id === connection.source);
    const isUra = sourceNode?.data?.componentType === 'ura';
    const connectionType = isUra ? 'option' : 'default';

    if (isUra && !canUseUraConnectionType(connection.source, connectionType)) {
      toast.error('A URA aceita no maximo 10 opcoes.');
      return;
    }

    setEdges((current) =>
      addEdge(
        {
          ...connection,
          id: `edge-${Date.now().toString(36)}`,
          animated: isUra,
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { connectionType, description: '' },
          label: isUra ? 'Opcao' : '',
        },
        current,
      ),
    );
  }, [nodes, setEdges]);

  const updateNodeData = (nodeId, patch) => {
    setNodes((current) =>
      ensureStartNode({
        nodes: current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node)),
        edges,
      }).nodes,
    );
  };

  const updateEdgeData = (edgeId, patch) => {
    setEdges((current) =>
      current.map((edge) => {
        if (edge.id !== edgeId) return edge;
        const nextData = { ...(edge.data || {}), ...patch };
        if (!canUseUraConnectionType(edge.source, nextData.connectionType, edge.id)) {
          toast.error(nextData.connectionType === 'option' ? 'A URA aceita no maximo 10 opcoes.' : 'A URA aceita apenas uma seta deste tipo.');
          return edge;
        }

        const label = nextData.connectionType === 'option'
          ? nextData.description || 'Opcao'
          : nextData.connectionType === 'invalid'
            ? 'Invalido'
            : nextData.connectionType === 'timeout'
              ? 'Tempo de Espera'
              : '';
        return { ...edge, data: nextData, label };
      }),
    );
  };

  const deleteNode = (nodeId) => {
    if (nodeId === CHATBOT_START_NODE_ID || nodes.find((node) => node.id === nodeId)?.data?.componentType === 'start') {
      toast.error('O componente inicio fluxo e obrigatorio e nao pode ser apagado.');
      return;
    }
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setSelectedNodeId('');
  };

  const deleteEdge = (edgeId) => {
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
    setSelectedEdgeId('');
  };

  const handleNodesChange = useCallback((changes) => {
    const filteredChanges = changes.filter((change) => {
      if (change.type !== 'remove') return true;
      const node = nodes.find((item) => item.id === change.id);
      return node?.data?.componentType !== 'start' && change.id !== CHATBOT_START_NODE_ID;
    });
    onNodesChange(filteredChanges);
  }, [nodes, onNodesChange]);

  const handleDragStart = (event, type) => {
    event.dataTransfer.setData('application/x-saastv-chatbot-component', type);
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/x-saastv-chatbot-component');
    if (!type || !reactFlowInstance?.screenToFlowPosition) return;
    addNode(type, reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [addNode, reactFlowInstance]);

  const blockExit = useCallback(() => {
    if (!hasUnsavedChanges) {
      navigate('/chatbot');
      return;
    }
    toast.error('Salve o flow antes de sair desta tela.');
  }, [hasUnsavedChanges, navigate]);

  const handleSave = () => {
    if (!hasUnsavedChanges) {
      toast.info('Nenhuma alteracao para salvar.');
      return;
    }
    saveMutation.mutate(buildSavePayload());
  };

  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = 'Salve o flow antes de sair desta tela.';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    window.history.pushState({ chatbotEditorLocked: true }, '');
    const handlePopState = () => {
      window.history.pushState({ chatbotEditorLocked: true }, '');
      toast.error('Salve o flow antes de sair desta tela.');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [hasUnsavedChanges]);

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Carregando editor...</div>;
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3">
        <Button variant="ghost" size="sm" onClick={blockExit}>
          <ArrowLeft className="h-4 w-4" /> Voltar
        </Button>
        <Input value={flowName} onChange={(event) => setFlowName(event.target.value)} className="h-9 max-w-xs font-semibold" />
        <div className="nodrag nopan flex flex-1 flex-wrap items-center gap-2" onPointerDownCapture={(event) => event.stopPropagation()}>
          {COMPONENTS.filter((item) => !item.locked).map((item) => (
            <Button
              key={item.type}
              type="button"
              variant="outline"
              size="sm"
              disabled={item.disabled}
              draggable={!item.disabled}
              onDragStart={(event) => handleDragStart(event, item.type)}
              onClick={() => addNode(item.type)}
              className="gap-2 cursor-grab active:cursor-grabbing"
              title={item.disabled ? 'Este componente sera ativado posteriormente.' : 'Clique para adicionar ou arraste para o canvas.'}
            >
              <i className={item.icon} />
              {item.label}
            </Button>
          ))}
        </div>
        <Button variant="outline" onClick={() => flow && downloadTextFile(`chatbot-flow-${flow.code}.json`, exportChatbotFlowJson({ ...flow, name: flowName, state: { nodes, edges, viewport: reactFlowInstance?.getViewport?.() || flow.state.viewport } }))}>
          <Download className="h-4 w-4" />
          JSON
        </Button>
        <Button onClick={handleSave} disabled={!flow || !hasUnsavedChanges || saveMutation.isPending}>
          <Save className="h-4 w-4" />
          {saveMutation.isPending ? 'Salvando...' : hasUnsavedChanges ? 'Salvar' : 'Sem alteracoes'}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setReactFlowInstance}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            deleteKeyCode={['Delete']}
            panOnScroll={false}
            fitView
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId('');
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId('');
            }}
            onPaneClick={() => {
              setSelectedNodeId('');
              setSelectedEdgeId('');
            }}
            defaultViewport={flow?.state?.viewport}
          >
            <MiniMap />
            <Controls />
            <Background gap={18} size={1} />
          </ReactFlow>
        </div>

        <PropertyPanel
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          nodes={nodes}
          edges={edges}
          customLabels={customLabels}
          onNodeChange={updateNodeData}
          onDeleteNode={deleteNode}
          onEdgeChange={updateEdgeData}
          onDeleteEdge={deleteEdge}
          onAssetUpload={(file, kind) => uploadAssetMutation.mutateAsync({ file, kind })}
        />
      </div>
    </div>
  );
}

export default function ChatbotFlowEditor() {
  return (
    <ReactFlowProvider>
      <ChatbotFlowEditorCanvas />
    </ReactFlowProvider>
  );
}
