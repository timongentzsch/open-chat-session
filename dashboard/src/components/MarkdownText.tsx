import { React, cn } from "@/sdk";
import {
  StreamdownTextPrimitive,
  useIsStreamdownCodeBlock,
} from "@assistant-ui/react-streamdown";
import type { ExtraProps } from "streamdown";
import type { ComponentPropsWithoutRef } from "react";
import { MARKDOWN_COLOR_CSS } from "@/chat-styles";

// Render every "\n" inside markdown text as a hard <br>. Without this,
// single newlines collapse to a space (CommonMark default) and the agent's
// tool-call log — one call per line — renders as one long mashed-up
// paragraph. Walks the remark AST and replaces text nodes that contain
// "\n" with alternating text + break nodes. Code blocks (no children) and
// inline code are untouched.
function remarkHardBreaks() {
  type AstNode = { type: string; value?: string; children?: AstNode[] };
  const walk = (node: AstNode) => {
    if (!node.children) return;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      walk(child);
      if (child.type !== "text" || typeof child.value !== "string" || !child.value.includes("\n")) continue;
      const parts = child.value.split("\n");
      const replacement: AstNode[] = [];
      parts.forEach((part, idx) => {
        if (part) replacement.push({ type: "text", value: part });
        if (idx < parts.length - 1) replacement.push({ type: "break" });
      });
      node.children.splice(i, 1, ...replacement);
    }
  };
  return (tree: AstNode) => walk(tree);
}

const md = {
  h1: "mb-2 text-base font-semibold first:mt-0 last:mb-0",
  h2: "mb-1.5 mt-3 text-sm font-semibold first:mt-0 last:mb-0",
  h3: "mb-1 mt-2.5 text-sm font-semibold first:mt-0 last:mb-0",
  p: "my-2 leading-relaxed first:mt-0 last:mb-0",
  list: "my-2 pl-5 marker:text-midground/70 [&>li]:mt-1",
  quote: "my-2 border-l-2 border-midground/30 pl-3 text-midground/80",
  cell: "border-b border-midground/20 px-2 py-1 text-left",
};

type HP<T extends keyof React.JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & ExtraProps;

const components = {
  h1: ({ className, ...props }: HP<"h1">) => <h1 className={cn(md.h1, className)} {...props} />,
  h2: ({ className, ...props }: HP<"h2">) => <h2 className={cn(md.h2, className)} {...props} />,
  h3: ({ className, ...props }: HP<"h3">) => <h3 className={cn(md.h3, className)} {...props} />,
  h4: ({ className, ...props }: HP<"h4">) => <h4 className={cn(md.h3, className)} {...props} />,
  p: ({ className, ...props }: HP<"p">) => <p className={cn(md.p, className)} {...props} />,
  a: ({ className, ...props }: HP<"a">) => (
    <a
      className={cn("underline underline-offset-2 hover:text-success", className)}
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }: HP<"blockquote">) => (
    <blockquote className={cn(md.quote, className)} {...props} />
  ),
  ul: ({ className, ...props }: HP<"ul">) => (
    <ul className={cn(md.list, "list-disc", className)} {...props} />
  ),
  ol: ({ className, ...props }: HP<"ol">) => (
    <ol className={cn(md.list, "list-decimal", className)} {...props} />
  ),
  li: ({ className, ...props }: HP<"li">) => <li className={cn("leading-relaxed", className)} {...props} />,
  table: ({ className, ...props }: HP<"table">) => (
    <table
      className={cn("my-2 block max-w-full overflow-x-auto border-separate border-spacing-0 text-xs", className)}
      {...props}
    />
  ),
  th: ({ className, ...props }: HP<"th">) => (
    <th className={cn(md.cell, "border-t font-medium text-midground/90", className)} {...props} />
  ),
  td: ({ className, ...props }: HP<"td">) => <td className={cn(md.cell, className)} {...props} />,
  pre: ({ className, ...props }: HP<"pre">) => (
    <pre
      className={cn(
        "my-2 max-w-full overflow-x-auto border border-midground/20 bg-background/30 p-2 text-xs leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  code: ({ className, ...props }: HP<"code">) => {
    const block = useIsStreamdownCodeBlock();
    return (
      <code
        data-aui-ocs-code={block ? "block" : "inline"}
        className={cn(
          !block && "border border-midground/20 bg-background/30 px-1 py-0.5 text-[0.9em]",
          className,
        )}
        {...props}
      />
    );
  },
};

export const MarkdownText = React.memo(function MarkdownText() {
  return (
    <>
      <style href="ocs-style-markdown-color" precedence="default">{MARKDOWN_COLOR_CSS}</style>
      <StreamdownTextPrimitive
        className={cn("ocs-markdown min-w-0 break-words text-foreground")}
        components={components}
        controls={false}
        remarkPlugins={[remarkHardBreaks]}
      />
    </>
  );
});
