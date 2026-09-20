# Worker cleanup

## 2026-09-20 — Очистка Redis при старте worker

verify: worker `b807647b` выпущен отдельно; API/frontend не перезапускались. Отсутствующий старый поток Redis корректно считается очищенным; WRONGTYPE, NOPERM и таймаут не скрываются. 8 777 backend-тестов, build/gates и отдельный Redis прошли. Production: marker=done, worker healthy, 0 рестартов и ERROR, XGROUP не зарегистрирован. 14 соседних контейнеров сохранены; backup 48 706 427 байт проверен. MaxListeners остаётся открытым и требует отдельной диагностики. Работа выполнена без дополнительных агентов, push не выполнялся.

Review: CLEAN for the narrow missing-stream classification. Error propagation, owner lease, deadline and TTL-protected reservation deletion remain intact. MaxListeners was observed but its cause is not established.
