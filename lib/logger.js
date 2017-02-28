const getPayload = require('../route/lib/get-payload')

module.exports = {
    createLogger() {
        return async function Logger(ctx, next) {
            const { db } = ctx
            ctx.log = {}
            try {
                await next()
            } catch(e) {
                if (ctx.status!==404)
                    ctx.status = 500
                if (!ctx.body)
                    ctx.body = { error: e.message }
                console.log(e.message)
                console.log(e.stack)
                if (ctx.log) {
                    ctx.log.error = {
                        message: e.message,
                        stack: e.stack
                    }
                }
            } finally {
                let isExcludedStatus = [400, 401, 403].indexOf(ctx.status) !== -1
                let isExcludedMethod = ['GET'].indexOf(ctx.method) !== -1
                if ( ctx.log && !isExcludedMethod && !isExcludedStatus ) {
                    // include extra information
                    let logEntry = Object.assign(
                        ctx.log,
                        { status: ctx.status, params: ctx.params, query: ctx.query, payload: getPayload(ctx) },
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
            await next()
        }
    }
}
