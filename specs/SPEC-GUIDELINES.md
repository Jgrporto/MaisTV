# SPEC Guidelines

Toda SPEC deve conter:

- Objetivo.
- Contexto.
- Escopo.
- Fora de escopo.
- Impacto esperado.
- Dependências.
- Riscos.
- Decisões técnicas.

## Toda SPEC deve responder

1. O que será construído?
2. Por que será construído?
3. Como será construído?
4. Quais partes do projeto serão afetadas?
5. Como validar a entrega?
6. O que fica fora do escopo?

## Padrão de escrita

Use linguagem clara, direta e objetiva.

Evite termos vagos como "melhorar", "otimizar", "ajustar" e "corrigir". Quando usar esses termos, explique exatamente o que deve mudar.

## Critérios mínimos

Uma SPEC só é considerada pronta quando:

- O objetivo está claro.
- O escopo está definido.
- O fora de escopo está definido.
- Os requisitos são verificáveis.
- O design técnico orienta a implementação.
- As decisões técnicas estão registradas.

## Versionamento das SPECs

- Pequenas correções podem ser feitas diretamente no arquivo correspondente.
- Mudanças estruturais devem ser registradas em `decisions.md` quando a SPEC possuir esse arquivo.
- Ao implementar uma funcionalidade, marque as tasks concluídas ou registre o motivo de pendência.
- A SPEC deve acompanhar a evolução real do projeto.
