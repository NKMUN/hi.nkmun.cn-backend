const {verify} = require('jsonwebtoken')
const AUTHORIZATION_PREFIX = 'Bearer '

async function TokenParser(ctx, next) {
    // check if token is valid, return 401 if not
    let tokenStr, authorization = ctx.request.get('Authorization') || ''
    if (authorization.startsWith(AUTHORIZATION_PREFIX))
        tokenStr = authorization.slice(AUTHORIZATION_PREFIX.length)

    if (!tokenStr) {
        ctx.status = 401
        ctx.body   = { status: false, message: 'No token' }
        ctx.set('WWW-Authenticate', AUTHORIZATION_PREFIX+'token_type="JWT"')
        return false
    }

    try {
        ctx.token = verify(tokenStr, ctx.JWT_SECRET)
        if (!ctx.token)
            throw new Error('Token invalid or expired')
    }catch(e){
        ctx.status = 401
        ctx.body   = { status: false, message: e.message }
        ctx.set('WWW-Authenticate', AUTHORIZATION_PREFIX+'token_type="JWT"')
        return false
    }

    if (next)
        await next()

    return true
}

function createAccessFilter(...access) {
    return async function AccessFilter(ctx, next) {
        if ( !ctx.token && !await TokenParser(ctx) )
            return

        // flatten access Array -> access Object
        let accessArr = (ctx.token && ctx.token.access) || []
        ctx.access = {}
        accessArr.forEach( $ => ctx.access[$] = true )

        // 403 or next()
        if ( ! access.some( $ => ctx.access[$] ) ) {
            ctx.status = 403
            ctx.body = { message : 'Forbidden' }
        } else {
            await next()
        }
    }
}


module.exports = {
    TokenParser,
    AccessFilter: createAccessFilter
}
