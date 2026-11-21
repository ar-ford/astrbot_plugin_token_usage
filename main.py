"""AstrBot 插件：Token 用量统计。

在 AstrBot WebUI 的插件可视化视图中展示最近一个月及更长时间的 Token 使用
情况。数据直接读取 AstrBot 自带的 ``provider_stats`` 表，不复制、不修改用户
数据，也不依赖任何第三方库。

作者: arford
"""

from __future__ import annotations

import asyncio
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

from astrbot.api.star import Context, Star
from astrbot.api.web import error_response, json_response, request

PLUGIN_NAME = "astrbot_plugin_token_usage"
PLUGIN_VERSION = "1.0.0"
DEFAULT_DAYS = 30
RANGE_DAYS = (30, 90, 180, 365)
CACHE_TTL_SECONDS = 30
MAX_SESSION_ROWS = 20
TOP_PROVIDER_SERIES = 5
OTHER_SERIES_NAME = "__other__"

# 页面刷新会触发多次请求，短缓存可以避免重复扫描数据库。
_cache: dict[int, tuple[float, dict[str, Any]]] = {}
_cache_lock: asyncio.Lock | None = None


def _utc_offset_label(now_local: datetime) -> str:
    """返回类似 ``UTC+08:00`` 的本地时区偏移标签。

    Args:
        now_local: 带时区信息的本地时间。

    Returns:
        UTC 偏移标签。
    """
    offset = now_local.utcoffset() or timedelta(0)
    total_seconds = int(offset.total_seconds())
    sign = "+" if total_seconds >= 0 else "-"
    total_seconds = abs(total_seconds)
    hours, remainder = divmod(total_seconds, 3600)
    minutes = remainder // 60
    return f"UTC{sign}{hours:02d}:{minutes:02d}"


def _to_local_date(hour_text: Any, tzinfo: Any) -> date | None:
    """把 SQLite 按 UTC 小时分组的时间文本转换为本地日期。

    Args:
        hour_text: ``strftime('%Y-%m-%d %H')`` 生成的 UTC 小时文本。
        tzinfo: 目标本地时区。

    Returns:
        本地日期；无法解析时返回 ``None``。
    """
    if not isinstance(hour_text, str) or not hour_text:
        return None
    try:
        parsed = datetime.strptime(hour_text, "%Y-%m-%d %H")
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc).astimezone(tzinfo).date()


def _parse_utc_datetime(value: Any) -> datetime | None:
    """把数据库返回的时间值解析为带 UTC 时区的 datetime。

    Args:
        value: ``datetime``、ISO 字符串或 ``None``。

    Returns:
        带 UTC 时区的 datetime；无法解析时返回 ``None``。
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def _empty_bucket() -> dict[str, Any]:
    """构造一个空的聚合桶。"""
    return {
        "tokens": 0,
        "input_other": 0,
        "input_cached": 0,
        "output": 0,
        "calls": 0,
        "errors": 0,
        "ttft_ms": 0.0,
        "ttft_samples": 0,
        "duration_ms": 0.0,
        "duration_samples": 0,
        "output_timed": 0,
    }


def _merge_bucket(target: dict[str, Any], source: dict[str, Any]) -> None:
    """把 ``source`` 的计数累加到 ``target``。"""
    for key in (
        "tokens",
        "input_other",
        "input_cached",
        "output",
        "calls",
        "errors",
        "ttft_ms",
        "ttft_samples",
        "duration_ms",
        "duration_samples",
        "output_timed",
    ):
        target[key] += source.get(key, 0)


def _aggregate(
    *,
    days: int,
    now_local: datetime,
    hourly_rows: list[Any],
    provider_hourly_rows: list[Any],
    model_rows: list[Any],
    umo_rows: list[Any],
    all_row: Any,
    started_at: float,
) -> dict[str, Any]:
    """把 SQL 聚合结果整理成前端所需的统计结构。

    Args:
        days: 统计范围天数（包含今天）。
        now_local: 带时区信息的当前本地时间。
        hourly_rows: 按 UTC 小时分组的调用统计。
        provider_hourly_rows: 按 UTC 小时 + 服务商分组的 Token 统计。
        model_rows: 按服务商 + 模型分组的 Token 统计。
        umo_rows: 按会话（UMO）分组的 Token 统计。
        all_row: 全量历史汇总行。
        started_at: 查询开始时间（``time.perf_counter()``）。

    Returns:
        可直接 JSON 序列化的统计数据。
    """
    tzinfo = now_local.tzinfo
    end_date = now_local.date()
    start_date = end_date - timedelta(days=days - 1)
    dates = [start_date + timedelta(days=offset) for offset in range(days)]

    daily = {day: _empty_bucket() for day in dates}
    provider_daily: dict[str, dict[date, int]] = {}
    provider_totals: dict[str, dict[str, Any]] = {}

    for row in hourly_rows:
        # (hour, calls, io, ic, out, out_timed, errors, ttft_sum, ttft_samples, dur_sum, dur_samples)
        local_day = _to_local_date(row[0], tzinfo)
        bucket = daily.get(local_day) if local_day else None
        if bucket is None:
            continue
        bucket["calls"] += int(row[1] or 0)
        bucket["input_other"] += int(row[2] or 0)
        bucket["input_cached"] += int(row[3] or 0)
        bucket["output"] += int(row[4] or 0)
        bucket["output_timed"] += int(row[5] or 0)
        bucket["errors"] += int(row[6] or 0)
        bucket["ttft_ms"] += float(row[7] or 0.0) * 1000
        bucket["ttft_samples"] += int(row[8] or 0)
        bucket["duration_ms"] += float(row[9] or 0.0) * 1000
        bucket["duration_samples"] += int(row[10] or 0)
        bucket["tokens"] = (
            bucket["input_other"] + bucket["input_cached"] + bucket["output"]
        )

    for row in provider_hourly_rows:
        # (hour, provider_id, calls, io, ic, out)
        local_day = _to_local_date(row[0], tzinfo)
        if local_day is None:
            continue
        provider_id = str(row[1] or "unknown")
        calls = int(row[2] or 0)
        input_other = int(row[3] or 0)
        input_cached = int(row[4] or 0)
        output = int(row[5] or 0)
        tokens = input_other + input_cached + output

        totals = provider_totals.setdefault(provider_id, _empty_bucket())
        totals["tokens"] += tokens
        totals["calls"] += calls
        totals["input_other"] += input_other
        totals["input_cached"] += input_cached
        totals["output"] += output

        day_map = provider_daily.setdefault(provider_id, {})
        day_map[local_day] = day_map.get(local_day, 0) + tokens

    models: dict[tuple[str, str], dict[str, Any]] = {}
    for row in model_rows:
        # (provider_id, provider_model, calls, io, ic, out)
        provider_id = str(row[0] or "unknown")
        model_name = str(row[1] or "Unknown")
        input_other = int(row[3] or 0)
        input_cached = int(row[4] or 0)
        output = int(row[5] or 0)
        item = models.setdefault(
            (provider_id, model_name),
            {
                "provider_id": provider_id,
                "model": model_name,
                "tokens": 0,
                "calls": 0,
                "input_other": 0,
                "input_cached": 0,
                "output": 0,
            },
        )
        item["tokens"] += input_other + input_cached + output
        item["calls"] += int(row[2] or 0)
        item["input_other"] += input_other
        item["input_cached"] += input_cached
        item["output"] += output

    sessions: list[dict[str, Any]] = []
    for row in umo_rows:
        # (umo, calls, io, ic, out)
        input_other = int(row[2] or 0)
        input_cached = int(row[3] or 0)
        output = int(row[4] or 0)
        sessions.append(
            {
                "umo": str(row[0] or "unknown"),
                "calls": int(row[1] or 0),
                "tokens": input_other + input_cached + output,
                "input_other": input_other,
                "input_cached": input_cached,
                "output": output,
            }
        )
    sessions.sort(key=lambda item: item["tokens"], reverse=True)

    totals = _empty_bucket()
    for bucket in daily.values():
        _merge_bucket(totals, bucket)
    range_tokens = totals["tokens"]
    calls = totals["calls"]
    success_rate = (calls - totals["errors"]) / calls if calls else 0.0
    avg_ttft_ms = totals["ttft_ms"] / totals["ttft_samples"] if totals["ttft_samples"] else 0.0
    avg_duration_ms = (
        totals["duration_ms"] / totals["duration_samples"]
        if totals["duration_samples"]
        else 0.0
    )
    duration_minutes = totals["duration_ms"] / 1000 / 60
    avg_tpm = totals["output_timed"] / duration_minutes if duration_minutes > 0 else 0.0

    provider_list = []
    for provider_id, item in provider_totals.items():
        provider_list.append(
            {
                "provider_id": provider_id,
                "tokens": item["tokens"],
                "calls": item["calls"],
                "input_other": item["input_other"],
                "input_cached": item["input_cached"],
                "output": item["output"],
                "share": item["tokens"] / range_tokens if range_tokens else 0.0,
            }
        )
    provider_list.sort(key=lambda item: item["tokens"], reverse=True)

    model_list = sorted(models.values(), key=lambda item: item["tokens"], reverse=True)
    for item in model_list:
        item["share"] = item["tokens"] / range_tokens if range_tokens else 0.0
        item["avg_tokens"] = item["tokens"] / item["calls"] if item["calls"] else 0.0

    for item in sessions:
        item["share"] = item["tokens"] / range_tokens if range_tokens else 0.0
    session_total = len(sessions)

    top_provider_ids = [item["provider_id"] for item in provider_list[:TOP_PROVIDER_SERIES]]
    trend_series = [
        {
            "name": provider_id,
            "tokens": provider_totals[provider_id]["tokens"],
            "data": [
                provider_daily.get(provider_id, {}).get(day, 0) for day in dates
            ],
        }
        for provider_id in top_provider_ids
    ]
    other_data = [0] * days
    for provider_id, day_map in provider_daily.items():
        if provider_id in top_provider_ids:
            continue
        for index, day in enumerate(dates):
            other_data[index] += day_map.get(day, 0)
    if any(other_data):
        trend_series.append(
            {
                "name": OTHER_SERIES_NAME,
                "tokens": sum(other_data),
                "data": other_data,
            }
        )

    daily_payload = [
        {
            "date": day.isoformat(),
            "tokens": daily[day]["tokens"],
            "input_other": daily[day]["input_other"],
            "input_cached": daily[day]["input_cached"],
            "output": daily[day]["output"],
            "calls": daily[day]["calls"],
        }
        for day in dates
    ]

    today_bucket = daily[end_date]
    today_payload = {
        "date": end_date.isoformat(),
        "tokens": today_bucket["tokens"],
        "calls": today_bucket["calls"],
        "input_other": today_bucket["input_other"],
        "input_cached": today_bucket["input_cached"],
        "output": today_bucket["output"],
    }

    all_calls = int(all_row[0] or 0) if all_row else 0
    all_input_other = int(all_row[1] or 0) if all_row else 0
    all_input_cached = int(all_row[2] or 0) if all_row else 0
    all_output = int(all_row[3] or 0) if all_row else 0
    all_tokens = all_input_other + all_input_cached + all_output
    first_seen = _parse_utc_datetime(all_row[4]) if all_row else None
    last_seen = _parse_utc_datetime(all_row[5]) if all_row else None
    first_local = first_seen.astimezone(tzinfo).date() if first_seen else None
    last_local = last_seen.astimezone(tzinfo).date() if last_seen else None
    tracked_days = (
        (last_local - first_local).days + 1 if first_local and last_local else 0
    )

    return {
        "generated_at": int(time.time() * 1000),
        "elapsed_ms": round((time.perf_counter() - started_at) * 1000, 1),
        "cached": False,
        "plugin_version": PLUGIN_VERSION,
        "timezone": _utc_offset_label(now_local),
        "days": days,
        "range": {"start": start_date.isoformat(), "end": end_date.isoformat()},
        "totals": {
            "tokens": range_tokens,
            "input_other": totals["input_other"],
            "input_cached": totals["input_cached"],
            "output": totals["output"],
            "calls": calls,
            "errors": totals["errors"],
            "success_rate": success_rate,
            "avg_ttft_ms": avg_ttft_ms,
            "avg_duration_ms": avg_duration_ms,
            "avg_tpm": avg_tpm,
            "avg_tokens_per_call": range_tokens / calls if calls else 0.0,
            "sessions": session_total,
            "providers": len(provider_list),
            "models": len(model_list),
            "active_days": sum(1 for bucket in daily.values() if bucket["tokens"] > 0),
        },
        "today": today_payload,
        "all_time": {
            "tokens": all_tokens,
            "input_other": all_input_other,
            "input_cached": all_input_cached,
            "output": all_output,
            "calls": all_calls,
            "first_date": first_local.isoformat() if first_local else None,
            "last_date": last_local.isoformat() if last_local else None,
            "tracked_days": tracked_days,
            "avg_tokens_per_call": all_tokens / all_calls if all_calls else 0.0,
        },
        "daily": daily_payload,
        "trend": {"providers": trend_series},
        "by_provider": provider_list,
        "by_model": model_list,
        "by_session": sessions[:MAX_SESSION_ROWS],
    }


class TokenUsagePlugin(Star):
    """AstrBot Token 用量统计插件。"""

    def __init__(self, context: Context, config: dict | None = None) -> None:
        """注册插件页视图所需的后端接口。

        Args:
            context: AstrBot 插件上下文。
            config: 插件配置（本插件当前没有配置项，仅为兼容 AstrBot 注入）。
        """
        super().__init__(context, config)
        context.register_web_api(
            f"/{PLUGIN_NAME}/stats",
            self.get_token_stats,
            ["GET"],
            "Token usage statistics for the plugin view",
        )

    async def get_token_stats(self):
        """返回插件页使用的 Token 统计 JSON。

        Returns:
            统计结果，或带有可读错误信息的错误响应。
        """
        days = request.query.get("days", DEFAULT_DAYS, type=int)
        if days not in RANGE_DAYS:
            days = DEFAULT_DAYS
        try:
            payload = await self._get_cached_payload(days)
        except Exception:
            # 延迟导入日志模块，保证异常信息写入 AstrBot 日志便于排查。
            try:
                from astrbot.core import logger

                logger.error("读取 Token 统计数据失败", exc_info=True)
            except Exception:
                pass
            return error_response(
                "读取 Token 统计数据失败，请查看 AstrBot 日志了解详情。",
                status_code=500,
            )
        return json_response(payload)

    async def _get_cached_payload(self, days: int) -> dict[str, Any]:
        """读取缓存或重新查询统计数据。

        Args:
            days: 统计范围天数。

        Returns:
            统计数据。
        """
        global _cache_lock
        cached = _cache.get(days)
        if cached and cached[0] > time.time():
            return {**cached[1], "cached": True}
        if _cache_lock is None:
            _cache_lock = asyncio.Lock()
        async with _cache_lock:
            cached = _cache.get(days)
            if cached and cached[0] > time.time():
                return {**cached[1], "cached": True}
            started_at = time.perf_counter()
            payload = await self._query_payload(days, started_at)
            payload["cached"] = False
            _cache[days] = (time.time() + CACHE_TTL_SECONDS, payload)
            return payload

    async def _query_payload(
        self,
        days: int,
        started_at: float,
    ) -> dict[str, Any]:
        """从 AstrBot 的 ``provider_stats`` 表汇总统计数据。

        Args:
            days: 统计范围天数。
            started_at: 查询开始时间（``time.perf_counter()``）。

        Returns:
            统计数据。
        """
        # 延迟导入数据库相关依赖，避免 AstrBot 版本过旧时影响插件加载。
        from sqlalchemy import case, func, select
        from sqlalchemy.exc import OperationalError

        from astrbot.core import db_helper
        from astrbot.core.db.po import ProviderStat

        now_local = datetime.now().astimezone()
        start_date = (now_local - timedelta(days=days - 1)).date()
        start_local = datetime.combine(
            start_date,
            datetime.min.time(),
            tzinfo=now_local.tzinfo,
        )
        start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)

        hour_expr = func.strftime("%Y-%m-%d %H", ProviderStat.created_at)
        base_filters = (
            ProviderStat.agent_type == "internal",
            ProviderStat.created_at >= start_utc,
        )
        hourly_stmt = (
            select(
                hour_expr,
                func.count(ProviderStat.id),
                func.coalesce(func.sum(ProviderStat.token_input_other), 0),
                func.coalesce(func.sum(ProviderStat.token_input_cached), 0),
                func.coalesce(func.sum(ProviderStat.token_output), 0),
                func.coalesce(
                    func.sum(
                        case(
                            (
                                ProviderStat.end_time > ProviderStat.start_time,
                                ProviderStat.token_output,
                            ),
                            else_=0,
                        )
                    ),
                    0,
                ),
                func.coalesce(
                    func.sum(case((ProviderStat.status == "error", 1), else_=0)),
                    0,
                ),
                func.coalesce(
                    func.sum(
                        case(
                            (
                                ProviderStat.time_to_first_token > 0,
                                ProviderStat.time_to_first_token,
                            ),
                            else_=0.0,
                        )
                    ),
                    0.0,
                ),
                func.coalesce(
                    func.sum(
                        case(
                            (ProviderStat.time_to_first_token > 0, 1),
                            else_=0,
                        )
                    ),
                    0,
                ),
                func.coalesce(
                    func.sum(
                        case(
                            (
                                ProviderStat.end_time > ProviderStat.start_time,
                                ProviderStat.end_time - ProviderStat.start_time,
                            ),
                            else_=0.0,
                        )
                    ),
                    0.0,
                ),
                func.coalesce(
                    func.sum(
                        case(
                            (ProviderStat.end_time > ProviderStat.start_time, 1),
                            else_=0,
                        )
                    ),
                    0,
                ),
            )
            .where(*base_filters)
            .group_by(hour_expr)
            .order_by(hour_expr)
        )
        provider_hourly_stmt = (
            select(
                hour_expr,
                ProviderStat.provider_id,
                func.count(ProviderStat.id),
                func.coalesce(func.sum(ProviderStat.token_input_other), 0),
                func.coalesce(func.sum(ProviderStat.token_input_cached), 0),
                func.coalesce(func.sum(ProviderStat.token_output), 0),
            )
            .where(*base_filters)
            .group_by(hour_expr, ProviderStat.provider_id)
        )
        model_stmt = (
            select(
                ProviderStat.provider_id,
                func.coalesce(ProviderStat.provider_model, "Unknown"),
                func.count(ProviderStat.id),
                func.coalesce(func.sum(ProviderStat.token_input_other), 0),
                func.coalesce(func.sum(ProviderStat.token_input_cached), 0),
                func.coalesce(func.sum(ProviderStat.token_output), 0),
            )
            .where(*base_filters)
            .group_by(ProviderStat.provider_id, ProviderStat.provider_model)
        )
        umo_stmt = (
            select(
                ProviderStat.umo,
                func.count(ProviderStat.id),
                func.coalesce(func.sum(ProviderStat.token_input_other), 0),
                func.coalesce(func.sum(ProviderStat.token_input_cached), 0),
                func.coalesce(func.sum(ProviderStat.token_output), 0),
            )
            .where(*base_filters)
            .group_by(ProviderStat.umo)
        )
        all_time_stmt = select(
            func.count(ProviderStat.id),
            func.coalesce(func.sum(ProviderStat.token_input_other), 0),
            func.coalesce(func.sum(ProviderStat.token_input_cached), 0),
            func.coalesce(func.sum(ProviderStat.token_output), 0),
            func.min(ProviderStat.created_at),
            func.max(ProviderStat.created_at),
        ).where(ProviderStat.agent_type == "internal")

        payload: dict[str, Any] | None = None
        for attempt in range(2):
            try:
                async with db_helper.get_db() as session:
                    hourly_rows = (await session.execute(hourly_stmt)).all()
                    provider_hourly_rows = (
                        await session.execute(provider_hourly_stmt)
                    ).all()
                    model_rows = (await session.execute(model_stmt)).all()
                    umo_rows = (await session.execute(umo_stmt)).all()
                    all_row = (await session.execute(all_time_stmt)).first()
                payload = _aggregate(
                    days=days,
                    now_local=now_local,
                    hourly_rows=hourly_rows,
                    provider_hourly_rows=provider_hourly_rows,
                    model_rows=model_rows,
                    umo_rows=umo_rows,
                    all_row=all_row,
                    started_at=started_at,
                )
                break
            except OperationalError:
                # SQLite 在写入高峰可能短暂锁库，稍后重试一次。
                if attempt == 0:
                    await asyncio.sleep(0.2)
                    continue
                raise
        if payload is None:
            raise RuntimeError("Token statistics query did not return a result.")

        await self._attach_session_aliases(db_helper, payload)
        return payload

    @staticmethod
    async def _attach_session_aliases(
        db_helper: Any,
        payload: dict[str, Any],
    ) -> None:
        """为会话排名补充用户别名，失败时保留原始 UMO。

        Args:
            db_helper: AstrBot 数据库助手。
            payload: 统计数据，原地修改 ``by_session``。
        """
        sessions = payload.get("by_session") or []
        if not sessions:
            return
        try:
            from astrbot.core.umo_alias import (
                build_umo_alias_map,
                serialize_umo_alias,
            )

            umos = [item["umo"] for item in sessions]
            aliases = build_umo_alias_map(await db_helper.get_umo_aliases(umos))
            for item in sessions:
                info = serialize_umo_alias(aliases.get(item["umo"]), item["umo"])
                item["display_name"] = info["display_name"]
                item["platform"] = item["umo"].split(":", 1)[0]
        except Exception:
            for item in sessions:
                item.setdefault("display_name", item["umo"])
                item["platform"] = item["umo"].split(":", 1)[0]
