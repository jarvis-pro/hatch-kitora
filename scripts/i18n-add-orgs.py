#!/usr/bin/env python3
"""
One-shot helper to merge PR-3 i18n keys into messages/en.json and messages/zh.json.

Run from repo root:
    python3 scripts/i18n-add-orgs.py

Idempotent — re-running won't duplicate keys (last-writer-wins on collisions).
After merging, re-format with prettier:
    pnpm format
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

DASHBOARD_NAV_EN = {
    "members": "Members",
    "organization": "Organization",
}
DASHBOARD_NAV_ZH = {
    "members": "成员",
    "organization": "组织",
}

AUDIT_ACTIONS_EN = {
    "org_created": "Organization created",
    "org_updated": "Organization updated",
    "org_deleted": "Organization deleted",
    "member_invited": "Member invited",
    "member_joined": "Member joined",
    "member_removed": "Member removed",
    "member_role_changed": "Member role changed",
    "ownership_transferred": "Ownership transferred",
}
AUDIT_ACTIONS_ZH = {
    "org_created": "创建组织",
    "org_updated": "组织信息更新",
    "org_deleted": "删除组织",
    "member_invited": "邀请成员",
    "member_joined": "成员加入",
    "member_removed": "移除成员",
    "member_role_changed": "成员角色变更",
    "ownership_transferred": "所有权转让",
}

ORGS_EN = {
    "switcher": {
        "label": "Workspace",
        "errors": {
            "switch": "Couldn't switch workspace.",
        },
    },
    "members": {
        "title": "Members",
        "subtitle": "Manage who has access to this workspace.",
        "listTitle": "Active members",
        "listCardTitle": "Members",
        "listCardDescription": "{count} active",
        "pendingTitle": "Pending invitations",
        "youTag": "you",
        "joined": "joined {date}",
        "expires": "expires {date}",
        "roleLabel": "Role",
        "roleChanged": "Role updated.",
        "transfer": "Make owner",
        "transferred": "Ownership transferred.",
        "remove": "Remove",
        "removed": "Member removed.",
        "revokeInvite": "Revoke",
        "inviteRevoked": "Invitation revoked.",
        "confirmRemove": "Remove this member?",
        "confirmTransfer": "Transfer ownership? You'll lose owner permissions.",
        "roles": {
            "OWNER": "Owner",
            "ADMIN": "Admin",
            "MEMBER": "Member",
        },
        "errors": {
            "generic": "Something went wrong.",
            "forbidden": "You don't have permission.",
            "cannot-remove-owner": "The owner can't be removed.",
            "cannot-demote-owner": "The owner role is reserved — transfer first.",
            "use-transfer": "Use transfer ownership instead.",
            "self-transfer": "You can't transfer to yourself.",
            "not-found": "Member not found.",
        },
        "invite": {
            "title": "Invite a teammate",
            "description": "They'll receive an email with a link to accept.",
            "emailLabel": "Email",
            "emailPlaceholder": "name@company.com",
            "roleLabel": "Role",
            "submit": "Send invite",
            "sending": "Sending…",
            "sent": "Invitation sent.",
            "roles": {
                "MEMBER": "Member",
                "ADMIN": "Admin",
            },
            "errors": {
                "generic": "Couldn't send invitation.",
                "forbidden": "You don't have permission.",
                "invalid-input": "Please enter a valid email.",
                "already-member": "This person is already a member.",
                "cannot-invite-owner": "Owner is reserved — transfer instead.",
            },
        },
    },
    "settings": {
        "title": "Organization",
        "subtitle": "Workspace name, URL slug and danger-zone actions.",
        "fields": {
            "name": "Name",
            "slug": "Slug",
        },
        "slugHint": "Lowercase letters, numbers and dashes. 3–40 chars.",
        "save": "Save changes",
        "saving": "Saving…",
        "saved": "Organization updated.",
        "basics": {
            "title": "Basics",
            "description": "How this workspace appears across Kitora.",
        },
        "danger": {
            "title": "Danger zone",
            "subtitle": "Irreversible actions.",
        },
        "errors": {
            "generic": "Couldn't save changes.",
            "forbidden": "You don't have permission.",
            "invalid-input": "Please check your input.",
            "invalid-slug": "Slug must be 3–40 chars, lowercase / digits / dashes.",
            "reserved-slug": "Slugs starting with 'personal-' are reserved.",
            "slug-taken": "That slug is already taken.",
        },
    },
    "danger": {
        "description": "Permanently delete this organization. All subscriptions, tokens and members are removed. This cannot be undone.",
        "confirmLabel": "Type {slug} to confirm",
        "delete": "Delete organization",
        "deleting": "Deleting…",
        "deleted": "Organization deleted.",
        "finalConfirm": "This is permanent. Continue?",
        "errors": {
            "generic": "Couldn't delete organization.",
            "forbidden": "You don't have permission.",
            "slug-mismatch": "The slug you typed doesn't match.",
            "personal-org": "Personal orgs are deleted via the account settings.",
        },
    },
    "invite": {
        "header": "Join {org}",
        "subheader": "You've been invited as a {role}. The invitation was sent to {email}.",
        "mustSignIn": "Sign in (or sign up) using {email} to accept.",
        "signInButton": "Sign in",
        "signUpButton": "Create an account",
        "switchAccount": "Sign in with a different account",
        "accept": "Accept invitation",
        "accepting": "Accepting…",
        "accepted": "Welcome to the team!",
        "roles": {
            "OWNER": "owner",
            "ADMIN": "admin",
            "MEMBER": "member",
        },
        "invalid": {
            "title": "Invalid invitation",
            "body": "This invitation link is invalid or has been revoked.",
        },
        "expired": {
            "title": "Invitation expired",
            "body": "Ask the organization admin to send a fresh invitation.",
        },
        "alreadyAccepted": {
            "title": "Already accepted",
            "body": "This invitation has already been used.",
        },
        "errors": {
            "generic": "Couldn't accept invitation.",
            "invalid": "Invitation link is no longer valid.",
            "expired": "Invitation has expired.",
            "wrong-email": "Sign in with {email} to accept this invitation.",
        },
    },
}

ORGS_ZH = {
    "switcher": {
        "label": "工作区",
        "errors": {
            "switch": "切换工作区失败。",
        },
    },
    "members": {
        "title": "成员",
        "subtitle": "管理此工作区的访问权限。",
        "listTitle": "活跃成员",
        "listCardTitle": "成员列表",
        "listCardDescription": "共 {count} 位",
        "pendingTitle": "待接受邀请",
        "youTag": "你",
        "joined": "{date} 加入",
        "expires": "{date} 过期",
        "roleLabel": "角色",
        "roleChanged": "角色已更新。",
        "transfer": "转让所有权",
        "transferred": "所有权已转让。",
        "remove": "移除",
        "removed": "成员已移除。",
        "revokeInvite": "撤销",
        "inviteRevoked": "邀请已撤销。",
        "confirmRemove": "确定移除此成员？",
        "confirmTransfer": "确认转让所有权？转让后你将失去 OWNER 权限。",
        "roles": {
            "OWNER": "所有者",
            "ADMIN": "管理员",
            "MEMBER": "成员",
        },
        "errors": {
            "generic": "操作失败。",
            "forbidden": "你没有权限执行此操作。",
            "cannot-remove-owner": "无法移除所有者。",
            "cannot-demote-owner": "所有者角色不可降级 — 请先转让。",
            "use-transfer": "请使用「转让所有权」。",
            "self-transfer": "不能将所有权转让给自己。",
            "not-found": "未找到该成员。",
        },
        "invite": {
            "title": "邀请伙伴",
            "description": "我们会给对方发一封带接受链接的邮件。",
            "emailLabel": "邮箱",
            "emailPlaceholder": "name@company.com",
            "roleLabel": "角色",
            "submit": "发送邀请",
            "sending": "发送中…",
            "sent": "邀请已发出。",
            "roles": {
                "MEMBER": "成员",
                "ADMIN": "管理员",
            },
            "errors": {
                "generic": "邀请发送失败。",
                "forbidden": "你没有权限。",
                "invalid-input": "请填写有效邮箱。",
                "already-member": "对方已是成员。",
                "cannot-invite-owner": "OWNER 角色保留 — 请使用转让所有权。",
            },
        },
    },
    "settings": {
        "title": "组织设置",
        "subtitle": "组织名称、URL slug 与危险操作。",
        "fields": {
            "name": "名称",
            "slug": "Slug",
        },
        "slugHint": "小写字母、数字和短横线，3–40 字符。",
        "save": "保存修改",
        "saving": "保存中…",
        "saved": "组织信息已更新。",
        "basics": {
            "title": "基础信息",
            "description": "组织在 Kitora 上的展示方式。",
        },
        "danger": {
            "title": "危险区",
            "subtitle": "不可撤销操作。",
        },
        "errors": {
            "generic": "保存失败。",
            "forbidden": "你没有权限。",
            "invalid-input": "请检查输入。",
            "invalid-slug": "Slug 需 3–40 字符的小写字母、数字或短横线。",
            "reserved-slug": "「personal-」开头的 slug 已被保留。",
            "slug-taken": "该 slug 已被占用。",
        },
    },
    "danger": {
        "description": "永久删除此组织，相关订阅、token、成员都会被清除，操作不可逆。",
        "confirmLabel": "输入 {slug} 确认",
        "delete": "删除组织",
        "deleting": "删除中…",
        "deleted": "组织已删除。",
        "finalConfirm": "此操作不可恢复，继续？",
        "errors": {
            "generic": "删除失败。",
            "forbidden": "你没有权限。",
            "slug-mismatch": "输入的 slug 与组织不一致。",
            "personal-org": "Personal 组织随账号删除一并处理。",
        },
    },
    "invite": {
        "header": "加入 {org}",
        "subheader": "邀请你以 {role} 身份加入，邀请发送至 {email}。",
        "mustSignIn": "请使用 {email} 登录或注册后接受邀请。",
        "signInButton": "登录",
        "signUpButton": "创建账号",
        "switchAccount": "切换其他账号登录",
        "accept": "接受邀请",
        "accepting": "处理中…",
        "accepted": "欢迎加入！",
        "roles": {
            "OWNER": "所有者",
            "ADMIN": "管理员",
            "MEMBER": "成员",
        },
        "invalid": {
            "title": "邀请无效",
            "body": "此邀请链接已失效或被撤销。",
        },
        "expired": {
            "title": "邀请已过期",
            "body": "请联系组织管理员重新发送邀请。",
        },
        "alreadyAccepted": {
            "title": "邀请已接受",
            "body": "此邀请已被使用。",
        },
        "errors": {
            "generic": "接受邀请失败。",
            "invalid": "邀请链接已失效。",
            "expired": "邀请已过期。",
            "wrong-email": "请用 {email} 登录后接受邀请。",
        },
    },
}


def deep_merge(target, source):
    for k, v in source.items():
        if isinstance(v, dict) and isinstance(target.get(k), dict):
            deep_merge(target[k], v)
        else:
            target[k] = v
    return target


def patch(path: Path, dashboard_nav: dict, audit_actions: dict, orgs: dict):
    data = json.loads(path.read_text(encoding="utf-8"))

    deep_merge(data.setdefault("dashboard", {}).setdefault("nav", {}), dashboard_nav)
    deep_merge(
        data.setdefault("admin", {}).setdefault("audit", {}).setdefault("actions", {}),
        audit_actions,
    )
    data["orgs"] = deep_merge(data.get("orgs", {}), orgs)

    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"  ✓ wrote {path.relative_to(REPO)}")


def main():
    print("Patching messages/en.json")
    patch(REPO / "messages" / "en.json", DASHBOARD_NAV_EN, AUDIT_ACTIONS_EN, ORGS_EN)
    print("Patching messages/zh.json")
    patch(REPO / "messages" / "zh.json", DASHBOARD_NAV_ZH, AUDIT_ACTIONS_ZH, ORGS_ZH)
    print("Done. Now run:  pnpm format")


if __name__ == "__main__":
    sys.exit(main())
