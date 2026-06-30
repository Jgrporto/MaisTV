import { Copy, ExternalLink, Phone, Reply, Workflow } from 'lucide-react';

const buttonIcon = (type = '') => {
  const normalized = String(type).toLowerCase();
  if (normalized.includes('url') || normalized.includes('site')) return ExternalLink;
  if (normalized.includes('phone') || normalized.includes('ligar')) return Phone;
  if (normalized.includes('flow') || normalized.includes('fluxo')) return Workflow;
  if (normalized.includes('copy') || normalized.includes('copiar')) return Copy;
  return Reply;
};

export default function TemplatePreview({ preview, emptyMessage = 'Selecione um HSM para visualizar a mensagem.' }) {
  if (!preview) {
    return <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">{emptyMessage}</div>;
  }

  const buttons = Array.isArray(preview.buttons) ? preview.buttons : [];
  const buttonParameters = Array.isArray(preview.buttonParameters) ? preview.buttonParameters : [];
  const headerType = String(preview.headerType || preview.headerFormat || '').toLowerCase();
  const isMediaHeader = ['image', 'video', 'document'].some((type) => headerType.includes(type));

  return (
    <div className="rounded-lg border border-border bg-[#e7f2ed] p-4">
      <div className="max-w-sm rounded-lg bg-white p-3 text-sm shadow-sm">
        {isMediaHeader ? (
          headerType.includes('image') && preview.headerMediaUrl ? (
            <img src={preview.headerMediaUrl} alt="Mídia do cabeçalho" className="mb-3 max-h-52 w-full rounded-md object-cover" />
          ) : headerType.includes('video') && preview.headerMediaUrl ? (
            <video controls preload="metadata" className="mb-3 max-h-52 w-full rounded-md object-cover">
              <source src={preview.headerMediaUrl} />
            </video>
          ) : (
            <div className="mb-3 flex min-h-28 items-center justify-center rounded-md border border-border bg-muted px-3 text-center text-xs text-muted-foreground">
              {preview.headerMediaUrl ? `Documento: ${preview.headerMediaUrl}` : 'Cabeçalho de mídia'}
            </div>
          )
        ) : preview.headerText ? (
          <div className="mb-2 font-semibold text-foreground">{preview.headerText}</div>
        ) : null}

        <div className="whitespace-pre-wrap text-foreground">{preview.body || 'Corpo do template sem texto.'}</div>

        {preview.footer ? <div className="mt-2 text-xs text-muted-foreground">{preview.footer}</div> : null}

        {buttons.length > 0 ? (
          <div className="mt-3 space-y-1.5 border-t border-border pt-2">
            {buttons.map((button, index) => {
              const Icon = buttonIcon(button.type);
              const parameter = buttonParameters.find((item) => Number(item?.index) === index)?.value;
              const label = button.label || button.text || `Botão ${index + 1}`;
              return (
                <div
                  key={button.id || `${button.label || button.text}-${index}`}
                  className="flex flex-col items-center justify-center gap-1 rounded-md border border-sky-100 bg-sky-50 px-3 py-2 text-center text-xs font-medium text-sky-700"
                >
                  <span className="inline-flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </span>
                  {parameter ? <span className="max-w-full truncate text-[11px] font-normal text-sky-600">{parameter}</span> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
