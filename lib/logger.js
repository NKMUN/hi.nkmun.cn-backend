module.exports = {
    createLogger() {
        return async function Logger(ctx, next) {
            ctx.log = {}

            let startTime = new Date()

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
            }

            let endTime = new Date()

            try {
                // introspective monitor
                let introspection = {
                    method: ctx.method,
                    url: ctx.url,
                    status: ctx.status,
                    time: new Date(),
                    response_time: endTime - startTime,
                    ip: ctx.request.ips,
                    user_agent: ctx.request.headers['user-agent'],
                }
                if (ctx.token)
                    introspection.token = ctx.token
                if (ctx.log && ctx.log.error) {
                    introspection.error = ctx.log.error.message
                    introspection.stack = ctx.log.error.stack
                }
                if (ctx.method === 'POST' || ctx.method === 'PUT' || ctx.method === 'PATCH')
                    introspection.payload = (ctx.log && ctx.log.payload) || ctx.request.body
                await ctx.db.collection('introspection').insertOne(introspection)
            } catch(e) {
                console.log('introspection insertion failed!')
                console.log(e.stack)
            }
        }
    }
}
