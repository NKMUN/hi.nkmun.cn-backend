const {verify} = require('jsonwebtoken')
const AUTHORIZATION_PREFIX = 'Bearer '
const curry = require('curry')

const matchAccessString = curry(
    (givenAccess, requiredAccess) => 
        givenAccess === 'root' || `${requiredAccess}.`.startsWith(`${givenAccess}.`)
)

const hasAccess = curry(
    (givenAccesses , requiredAccess) => 
        givenAccesses.find(givenAccess => matchAccessString(givenAccess, requiredAccess))
)

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
        ctx.hasAccessTo = hasAccess((ctx.token && ctx.token.access || []))
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

function createAccessFilter(...requiredAccesses) {
    return async function AccessFilter(ctx, next) {
        if ( !ctx.token && !await TokenParser(ctx) )
            return false

        if (requiredAccesses.some( ctx.hasAccessTo )) {
            if (next)
                await next()
            return true
        } else {
            ctx.status = 403
            ctx.body = { message: 'Forbidden' }
        }
    }
}

module.exports = {
    TokenParser,
    AccessFilter: createAccessFilter
}
