/**
 * Data table primitives — presentational only (no sorting/data logic). Compose to
 * build standings-style tables with consistent styling, sticky header, and a
 * horizontal scroll wrapper for small screens.
 *
 *   <Table>
 *     <THead>
 *       <TR>
 *         <TH>Owner</TH>
 *         <TH align="right">W-L-T</TH>
 *       </TR>
 *     </THead>
 *     <TBody>
 *       <TR><TD>…</TD><TD align="right">…</TD></TR>
 *     </TBody>
 *   </Table>
 */
import { cn } from '@/lib/utils';

type Align = 'left' | 'center' | 'right';

const ALIGN: Record<Align, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/** Scroll wrapper + base table. */
export function Table({ className, children, ...rest }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
      <table className={cn('w-full border-collapse text-sm', className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

export function THead({ className, children, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cn('bg-surface', className)} {...rest}>
      {children}
    </thead>
  );
}

export function TBody({ className, children, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cn('divide-y divide-border', className)} {...rest}>
      {children}
    </tbody>
  );
}

export function TR({ className, children, ...rest }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn('border-b border-border last:border-0', className)} {...rest}>
      {children}
    </tr>
  );
}

interface CellProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  align?: Align;
}

export function TH({ align = 'left', className, children, ...rest }: CellProps) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-3 py-3 text-xs font-semibold uppercase tracking-wide text-subtle sm:px-4',
        ALIGN[align],
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TD({ align = 'left', className, children, ...rest }: CellProps) {
  return (
    <td
      className={cn('whitespace-nowrap px-3 py-3 text-foreground sm:px-4', ALIGN[align], className)}
      {...rest}
    >
      {children}
    </td>
  );
}
