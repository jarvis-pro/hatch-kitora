import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SearchFormProps {
  /** 表单 GET 到的路径（例如 "/admin/users"）。 */
  action: string;
  defaultValue?: string;
  placeholder: string;
  submitLabel: string;
}

/**
 * 普通 HTML 表单 — 作为 GET 提交以便查询降落在 URL 中，
 * 服务器组件使用新 searchParams 重新渲染。无需 JS。
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
