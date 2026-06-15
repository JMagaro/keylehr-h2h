/**
 * Container — centers content and applies the app's responsive horizontal gutters
 * and max width. Use as the single horizontal-padding owner so pages stay aligned.
 */
import { cn } from '@/lib/utils';

type ContainerElement =
  | 'div'
  | 'main'
  | 'section'
  | 'header'
  | 'footer'
  | 'nav'
  | 'ul';

interface ContainerProps extends React.HTMLAttributes<HTMLElement> {
  /** Element to render. Defaults to `div`. */
  as?: ContainerElement;
  /** Max-width preset. `wide` for full layouts, `narrow` for prose. Default `default`. */
  width?: 'narrow' | 'default' | 'wide';
}

const WIDTHS: Record<NonNullable<ContainerProps['width']>, string> = {
  narrow: 'max-w-3xl',
  default: 'max-w-6xl',
  wide: 'max-w-7xl',
};

export function Container({
  as: Tag = 'div',
  width = 'default',
  className,
  children,
  ...rest
}: ContainerProps) {
  return (
    <Tag className={cn('mx-auto w-full px-4 sm:px-6 lg:px-8', WIDTHS[width], className)} {...rest}>
      {children}
    </Tag>
  );
}
