import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SearchFormProps {
  /** Path the form GETs to (e.g. "/admin/users"). */
  action: string;
  defaultValue?: string;
  placeholder: string;
  submitLabel: string;
}

/**
 * Plain HTML form — submits as GET so the query lands in the URL and the
 * server component re-renders with the new searchParams. No JS needed.
 */
export function SearchForm({ action, defaultValue, placeholder, submitLabel }: SearchFormProps) {
  return (
    <form action={action} method="get" className="flex gap-2">
      <Input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="max-w-xs"
      />
      <Button type="submit" variant="outline">
        {submitLabel}
      </Button>
    </form>
  );
}
