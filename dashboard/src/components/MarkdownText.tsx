import { React, cn } from "@/sdk";
import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

const md = {
  h1: "mb-2 text-base font-semibold first:mt-0 last:mb-0",
  h2: "mb-1.5 mt-3 text-sm font-semibold first:mt-0 last:mb-0",
  h3: "mb-1 mt-2.5 text-sm font-semibold first:mt-0 last:mb-0",
  p: "my-2 leading-relaxed first:mt-0 last:mb-0",
  list: "my-2 ml-4 marker:text-midground/70 [&>li]:mt-1",
  quote: "my-2 border-l-2 border-midground/30 pl-3 text-midground/80",
  cell: "border-b border-midground/20 px-2 py-1 text-left",
};

const components = memoizeMarkdownComponents({
  h1: ({ className, ...props }: any) => <h1 className={cn(md.h1, className)} {...props} />,
  h2: ({ className, ...props }: any) => <h2 className={cn(md.h2, className)} {...props} />,
  h3: ({ className, ...props }: any) => <h3 className={cn(md.h3, className)} {...props} />,
  h4: ({ className, ...props }: any) => <h4 className={cn(md.h3, className)} {...props} />,
  p: ({ className, ...props }: any) => <p className={cn(md.p, className)} {...props} />,
  a: ({ className, ...props }: any) => (
    <a
      className={cn("underline underline-offset-2 hover:text-emerald-300", className)}
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }: any) => (
    <blockquote className={cn(md.quote, className)} {...props} />
  ),
  ul: ({ className, ...props }: any) => (
    <ul className={cn(md.list, "list-disc", className)} {...props} />
  ),
  ol: ({ className, ...props }: any) => (
    <ol className={cn(md.list, "list-decimal", className)} {...props} />
  ),
  li: ({ className, ...props }: any) => <li className={cn("leading-relaxed", className)} {...props} />,
  table: ({ className, ...props }: any) => (
    <table
      className={cn("my-2 block max-w-full overflow-x-auto border-separate border-spacing-0 text-xs", className)}
      {...props}
    />
  ),
  th: ({ className, ...props }: any) => (
    <th className={cn(md.cell, "border-t font-medium text-midground/90", className)} {...props} />
  ),
  td: ({ className, ...props }: any) => <td className={cn(md.cell, className)} {...props} />,
  pre: ({ className, ...props }: any) => (
    <pre
      className={cn(
        "my-2 max-w-full overflow-x-auto rounded-md border border-midground/20 bg-black/20 p-2 text-xs leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  code: ({ className, ...props }: any) => {
    const block = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !block && "rounded border border-midground/20 bg-black/20 px-1 py-0.5 text-[0.9em]",
          className,
        )}
        {...props}
      />
    );
  },
});

export const MarkdownText = React.memo(function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className={cn("min-w-0 break-words")}
      components={components}
      remarkPlugins={[remarkGfm]}
    />
  );
});
