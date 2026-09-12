/** `<Link>` without a framework: an anchor into the hash router. */
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { navigate } from "./next-navigation";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children?: ReactNode;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
};

export default function Link({ href, children, onClick, prefetch: _p, replace: _r, scroll: _s, ...rest }: Props) {
  return (
    <a
      href={`#${href}`}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        // Let the OS handle a modified click the way it would anywhere else.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
