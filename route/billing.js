const Router = require('koa-router')
const route = new Router()
const { IsSelfOrAdmin, School } = require('./school')
const { Sessions } = require('./session')

function differenceOfDays(a, b) {
    return Math.round( (new Date(a) - new Date(b)) / (24*3600*1000) )
}

async function getBillingDetail(ctx, schoolId, round = '1') {
    let school = await ctx.db.collection('school').findOne(
        { _id: schoolId },
        { school: 1, seat: 1 }
    )

    let reservations = await ctx.db.collection('reservation').aggregate([
        { $match: { school: school._id, round } },
        { $lookup: {
            from: 'hotel',
            localField: 'hotel',
            foreignField: '_id',
            as: 'hotel'
        }},
        { $unwind: '$hotel' },
        { $project: {
            _id: false,
            id: '$_id',
            checkIn: '$checkIn',
            checkOut: '$checkOut',
            hotel: {
                id: '$hotel._id',
                name: '$hotel.name',
                type: '$hotel.type',
                price: '$hotel.price',
            }
        } }
    ]).toArray()

    await Sessions(ctx)
    let sessions = ctx.sessions
    let seat = school.seat[round] || {}

    let detail = []

    // sessions
    for (let key in seat) {
        if (seat[key]) {
            let session = sessions.find( $ => $._id === key )
            if (session)
                detail.push({
                    name: session.name,
                    type: '会场',
                    price: session.price,
                    amount: seat[key],
                })
        }
    }

    // reservations
    reservations.forEach( reservation => {
        let days = differenceOfDays(reservation.checkOut, reservation.checkIn)
        detail.push({
            name: reservation.hotel.name + '（' + reservation.hotel.type + '）',
            type: '住宿',
            price: reservation.hotel.price,
            amount: days,
        })
    })

    detail.forEach( $ => $.sum = $.price * $.amount )

    return detail
}

route.get('/schools/:id/billing',
    IsSelfOrAdmin,
    School,
    async ctx => {
        const round = ctx.query.round || ctx.school.stage[0] || '1'
        ctx.status = 200
        ctx.body = await getBillingDetail(ctx, ctx.params.id, round)
    }
)

module.exports = {
    routes: route.routes(),
    getBillingDetail
}
