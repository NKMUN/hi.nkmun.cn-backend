const getPayload = require('../route/lib/get-payload')

module.exports = {
    createLogger() {
        return async function Logger(ctx, next) {
            const { db } = ctx
            ctx.log = {}
            try {
                await next()
            } catch(e) {
                if (!ctx.body)
                    ctx.body = { error: e.message }
                if (ctx.status < 400)
                    ctx.status = 500
                console.log(e.message)
                console.log(e.stack)
                if (ctx.log) {
                    ctx.log.error = {
                        message: e.message,
                        stack: e.stack
                    }
                }
                // check for failed mongo connection
                if (   e.toString().indexOf('Topology was destroyed') !== -1
                    || e.toString().indexOf('failed to reconnect') !== -1
                ) {
                    process.exit(5)
                    return
                }
            } finally {
                let isExcludedStatus = [400, 401, 403].indexOf(ctx.status) !== -1
                let isExcludedMethod = ['GET'].indexOf(ctx.method) !== -1
                if ( ctx.log && !isExcludedMethod && !isExcludedStatus ) {
                    // include extra information
                    let logEntry = Object.assign(
                        { payload: getPayload(ctx) },    // allow middlewares to surpass certain payloads, eg: password
                        ctx.log,
                        { status: ctx.status, params: ctx.params, query: ctx.query },
                        { token: ctx.token || null },
                        { timestamp: (new Date()).valueOf() }
                    )
                    await db.collection('log').insert( logEntry )
                }
            }
        }
    },
    LogOp(facility, op) {
        return async function(ctx, next) {
            if (ctx.log) {
                ctx.log.facility = facility
                ctx.log.op = op
            }
            if (next)
                await next()
        }
    }
}
