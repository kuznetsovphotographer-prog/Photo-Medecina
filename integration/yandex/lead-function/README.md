# Приём заявок promedphoto.ru и Postbox

Публичный `index.handler` сохраняет текущий адрес формы
`https://functions.yandexcloud.net/d4efp1mug81s92flsuep`.
Карточки открываются в существующей защищённой CRM
`https://functions.yandexcloud.net/d4e5ur2fo156lrcve6id?admin=1&lead=<ID>`,
читающей медицинскую YDB через `PROMEDPHOTO_DATABASE`.

18.11.2026 основной агент выпустил публичную версию `d4er5imo0euvv15hu727` и
закрытый отправитель `promedphoto-postbox` (`d4e8v8h5qdm3sen1tgd9`), версия
`d4ecj3o5uk3muftkipu1`. GET приёмника: HTTP 200, `deliveryMode:postbox`,
`databaseChecked:true`, `relayConfigured:false`. Закрытый prepare успешен,
таймер `a1sp4t70n92ob0tr9h5a` Active. Синтетическая заявка
`317e6faa-7511-46e1-944d-9b5e6aa31277` прошла YDB, Postbox Delivery
18.11.2026 в 15:57:48 МСК, inbox и защищённую карточку общей CRM.
Фактические результаты — в `docs/POSTBOX-RELEASE-2026-11-18.md` проекта.

## Приём и совместимость

`DELIVERY_MODE=postbox`: валидация Origin и полей → одна serializableReadWrite-транзакция
с INSERT в `leads`, `consent_events`, `notification_outbox` → HTTP 202
`{ok:true,stored:true,submissionId,notification:"pending"}`. В запросе посетителя
Postbox, Cloudflare и Telegram не вызываются. Ошибка письма не отменяет приём.
Идентичный повтор ID возвращает 200 / `already-recorded`, изменение данных — 409.
Повтор исторического ID не создаёт outbox. Первоначальные данные/согласие/TTL не заменяются.

Форма и сроки хранения сохранены: lead/outbox — год, consent — три года.
Поддерживаются `2026-10-27-medical-1` и `2026-11-18-medical-postbox-1`;
записывается фактически присланная редакция. Уже открытые формы продолжают работать.

К четырём старым колонкам outbox добавляются nullable `site_host`, `message_id`.
Backfill отсутствует. Старые relay-состояния `pending`, `failed`, `sending`,
`sent`, `uncertain` не выбираются отправителем. Новые почтовые задания —
`postbox-pending`; при `storage-only` — `disabled`. Старый `cloudflare-relay`
оставлен для совместимости; для перехода обязательно переключить режим на `postbox`.

Приёмнику нужны действующие `ENDPOINT`, `DATABASE`, `DELIVERY_MODE=postbox`
и прежний сервисный аккаунт. Ему не нужны почтовые или relay-секреты. GET проверяет YDB
и возвращает `deliveryMode`, `databaseChecked`.

## Закрытый отправитель

Отдельная **непубличная** функция использует тот же ZIP, `postbox.drain`,
Node.js 22, 128–256 МБ, 60 секунд. Её переменные:

~~~text
DELIVERY_MODE=postbox
ENDPOINT=<действующий endpoint медицинской YDB>
DATABASE=<действующий путь медицинской YDB>
POSTBOX_FROM_EMAIL=notifications@prointeriors.ru
POSTBOX_TO_EMAIL=TheAlexMay@yandex.ru
~~~

Аккаунт должен иметь доступ к этой YDB и существующему подтверждённому отправителю
в том же каталоге с ролью `postbox.sender`. Используется IAM-токен функции
`context.token.access_token` в `X-YaCloud-SubjectToken`; статических ключей нет.
CRM-пароль, токены Telegram и relay в закрытый отправитель не копируются.

Сначала закрытый вызов `{"prepare":true}` подготавливает схему без чтения заданий
и отправки писем. Затем отдельный минутный таймер `* * ? * * *` вызывает отправитель.
Расписание общего монитора не меняется.

За запуск выбираются до пяти ID. Атомарный захват фиксируется до внешнего запроса.
Письмо: серверный домен `promedphoto.ru`, ID, серверное время в Москве, кнопка
«Открыть заявку» и обычная ссылка на ту же защищённую карточку CRM.
Тема: `Новая заявка с сайта promedphoto.ru`.
Имя, телефон, email клиента, расчёт, способ связи, устройство, ОС и доказательство
согласия в письмо не входят.

| Состояние | Значение |
| --- | --- |
| `postbox-pending` | Первая попытка |
| `postbox-sending-1/2/3` | Захват; автоматически по возрасту не освобождается |
| `postbox-sent` | API принял письмо, сохранён MessageId; Delivery проверяется отдельно |
| `postbox-retry-1/2` | Только явный 429 или ошибка до соединения, максимум три попытки |
| `postbox-failed` | Окончательный отказ или исчерпаны безопасные повторы |
| `postbox-uncertain` | Тайм-аут, 408/5xx, нечитаемый/оборванный ответ; автоповтора нет |
| `disabled` | Хранение без отправки |

Если запись результата после отправки не удалась, остаётся `postbox-sending-N`,
повторной отправки нет. При неопределённости сопоставлять журнал Postbox, Message-ID,
получателя, время, `X-Submission-Id` и письмо во входящих. Отсутствие Delivery само
по себе не доказывает отказ. Не возвращать uncertain/sending в pending по возрасту.
Ручной повтор — после установленного отказа и решения владельца.

## Проверка и выпуск

~~~powershell
node --test integration/yandex/lead-function/*.test.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File integration/yandex/lead-function/build-zip.ps1
~~~

Тесты без сети: atomic rollback, конкурентные повторы и захват, миграция старой схемы,
отсутствие backfill, две редакции согласия, успех формы до доставки, отказы/тайм-ауты,
отсутствие клиентских данных в письме.

Архив `output/promedphoto-ydb-lead-function.zip`: ровно семь корневых файлов
`index.js`, `validation.js`, `storage.js`, `postbox.js`, `postbox-store.js`,
`package.json`, `package-lock.json`. Он подходит обеим функциям с разными entrypoint.
Lockfile v2 совместим с npm 7, версии зависимостей сохранены. Тесты, документы, секреты,
node_modules и данные клиентов в ZIP не входят.

Порядок: сверить active-код и параметры → закрытый sender/prepare → его таймер →
приёмник с postbox → документы сайта → одна синтетическая заявка → сверить lead,
consent, outbox, авторизацию CRM, Message-ID, Delivery и inbox.
Фактические версии и результаты записываются в отдельный отчёт выпуска.
